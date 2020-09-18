/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Adguard Browser Extension.  If not, see <http://www.gnu.org/licenses/>.
 */

import { subscriptions } from './subscription';
import { listeners } from '../../notifier';
import { backend } from './service-client';
import { antiBannerService } from '../antibanner';
import { log } from '../../utils/log';
import { settings } from '../../settings/user-settings';
import { browserUtils } from '../../utils/browser-utils';

/**
 * Filters update service
 */
export const filtersUpdate = (() => {
    /**
     * Delay before doing first filters update check -- 5 minutes
     */
    const UPDATE_FILTERS_DELAY = 5 * 60 * 1000;

    // Get filters update period
    let filtersUpdatePeriod = settings.getFiltersUpdatePeriod();

    /**
     * Gets expires in sec end return in ms
     * If expires was less then minimumExpiresTime or we couldn't parse its value,
     * then return minimumExpiresTime
     * @param {*} expires
     * @returns {number}
     */
    const normalizeExpires = (expires) => {
        const minimumExpiresSec = 60 * 60;

        expires = Number.parseInt(expires, 10);

        if (Number.isNaN(expires) || expires < minimumExpiresSec) {
            expires = minimumExpiresSec;
        }

        return expires * 1000;
    };

    /**
     * Select filters for update. It depends on the time of last update,
     * on the filter enable status and group enable status
     * @param forceUpdate Force update flag.
     * @param filtersToUpdate Optional array of filters
     * @returns object
     */
    const selectFilterIdsToUpdate = (forceUpdate, filtersToUpdate) => {
        const filterIds = [];
        const customFilterIds = [];
        const filters = filtersToUpdate || subscriptions.getFilters();

        const needUpdate = (filter) => {
            const { lastCheckTime } = filter;
            let { expires } = filter;

            if (!lastCheckTime) {
                return true;
            }

            expires = normalizeExpires(expires);
            if (filtersUpdatePeriod === settings.DEFAULT_FILTERS_UPDATE_PERIOD) {
                return lastCheckTime + expires <= Date.now();
            }

            return lastCheckTime + filtersUpdatePeriod <= Date.now();
        };

        for (let i = 0; i < filters.length; i += 1) {
            const filter = filters[i];
            const group = subscriptions.getGroup(filter.groupId);
            if (filter.installed && filter.enabled && group.enabled) {
                if (forceUpdate || needUpdate(filter)) {
                    if (filter.customUrl) {
                        customFilterIds.push(filter.filterId);
                    } else {
                        filterIds.push(filter.filterId);
                    }
                }
            }
        }

        return {
            filterIds,
            customFilterIds,
        };
    };

    /**
     * Loads filter versions from remote server
     *
     * @param filterIds Filter identifiers
     * @param callback Callback (called when load is finished)
     * @private
     */
    const loadFiltersMetadataFromBackend = async (filterIds, callback) => {
        if (filterIds.length === 0) {
            callback(true, []);
            return;
        }

        const loadSuccess = (filterMetadataList) => {
            log.debug(
                'Retrieved response from server for {0} filters, result: {1} metadata',
                filterIds.length,
                filterMetadataList.length,
            );
            callback(true, filterMetadataList);
        };

        const loadError = (e) => {
            log.error(
                'Error retrieved response from server for filters {0}, cause: {1}',
                filterIds,
                e.message,
            );
            callback(false);
        };

        try {
            const filterMetadataList = await backend.loadFiltersMetadata(filterIds);
            loadSuccess(filterMetadataList);
        } catch (e) {
            loadError(e);
        }
    };

    /**
     * Loads filter rules
     *
     * @param filterMetadata Filter metadata
     * @param forceRemote Force download filter rules from remote server
     * (if false try to download local copy of rules if it's possible)
     * @param callback Called when filter rules have been loaded
     * @private
     */
    function loadFilterRules(filterMetadata, forceRemote, callback) {
        const filter = subscriptions.getFilter(filterMetadata.filterId);

        filter._isDownloading = true;
        listeners.notifyListeners(listeners.START_DOWNLOAD_FILTER, filter);

        const successCallback = (filterRules) => {
            log.info('Retrieved response from server for filter {0}, rules count: {1}',
                filter.filterId,
                filterRules.length);
            delete filter._isDownloading;
            filter.version = filterMetadata.version;
            filter.lastUpdateTime = filterMetadata.timeUpdated;
            filter.lastCheckTime = forceRemote ? Date.now() : filterMetadata.timeUpdated;
            filter.loaded = true;
            filter.expires = filterMetadata.expires;
            // notify listeners
            listeners.notifyListeners(listeners.SUCCESS_DOWNLOAD_FILTER, filter);
            listeners.notifyListeners(listeners.UPDATE_FILTER_RULES, filter, filterRules);
            callback(true);
        };

        const errorCallback = (cause) => {
            log.error(
                'Error retrieving response from the server for filter {0}, cause: {1}:',
                filter.filterId,
                cause || ''
            );
            delete filter._isDownloading;
            listeners.notifyListeners(listeners.ERROR_DOWNLOAD_FILTER, filter);
            callback(false);
        };

        (async () => {
            try {
                const filterRules = await backend.loadFilterRules(
                    filter.filterId,
                    forceRemote,
                    settings.isUseOptimizedFiltersEnabled()
                );
                successCallback(filterRules);
            } catch (e) {
                errorCallback(e);
            }
        })();
    }

    /**
     * Loads filters (ony-by-one) from the remote server
     *
     * @param filterMetadataList List of filter metadata to load
     * @param callback Called when filters have been loaded
     * @private
     */
    const loadFiltersFromBackend = (filterMetadataList, callback) => {
        const promises = filterMetadataList
            .map(filterMetadata => new Promise((resolve, reject) => {
                loadFilterRules(filterMetadata, true, (success) => {
                    if (!success) {
                        return reject();
                    }
                    return resolve(filterMetadata.filterId);
                });
            }));

        Promise.all(promises)
            .then((filterIds) => {
                callback(true, filterIds);
            })
            .catch(() => {
                callback(false);
            });
    };

    /**
     * Update filters with custom urls
     *
     * @param customFilterIds
     * @param callback
     */
    function updateCustomFilters(customFilterIds, callback) {
        if (customFilterIds.length === 0) {
            callback([]);
            return;
        }

        const promises = customFilterIds.map(filterId => new Promise((resolve) => {
            const filter = subscriptions.getFilter(filterId);
            const onUpdate = (updatedFilterId) => {
                if (updatedFilterId) {
                    return resolve(filter);
                }
                return resolve();
            };
            subscriptions.updateCustomFilter(filter.customUrl, {}, onUpdate);
        }));

        Promise.all(promises).then((filters) => {
            const updatedFilters = filters.filter(f => f);
            if (updatedFilters.length > 0) {
                const filterIdsString = updatedFilters.map(f => f.filterId).join(', ');
                log.info(`Updated custom filters with ids: ${filterIdsString}`);
            }

            callback(updatedFilters);
        });
    }

    /**
     * Checks filters updates.
     *
     * @param forceUpdate Normally we respect filter update period. But if this parameter is
     *                    true - we ignore it and check updates for all filters.
     * @param successCallback Called if filters were updated successfully
     * @param errorCallback Called if something gone wrong
     * @param filters     Optional Array of filters to update
     */
    const checkAntiBannerFiltersUpdate = (forceUpdate, successCallback, errorCallback, filters) => {
        const noop = () => {}; // empty callback
        successCallback = successCallback || noop;
        errorCallback = errorCallback || noop;

        // Don't update in background if request filter isn't running
        if (!forceUpdate && !antiBannerService.isRunning()) {
            return;
        }

        log.info('Start checking filters updates');

        // Select filters for update
        const toUpdate = selectFilterIdsToUpdate(forceUpdate, filters);
        const filterIdsToUpdate = toUpdate.filterIds;
        const customFilterIdsToUpdate = toUpdate.customFilterIds;

        const totalToUpdate = filterIdsToUpdate.length + customFilterIdsToUpdate.length;
        if (totalToUpdate === 0) {
            successCallback([]);
            log.info('There is no filters to update');
            return;
        }

        log.info('Checking updates for {0} filters', totalToUpdate);

        // Load filters with changed version
        const loadFiltersFromBackendCallback = (filterMetadataList) => {
            loadFiltersFromBackend(filterMetadataList, (success, filterIds) => {
                if (success) {
                    const filters = filterIds
                        .map(subscriptions.getFilter)
                        .filter(f => f);

                    updateCustomFilters(customFilterIdsToUpdate, (customFilters) => {
                        successCallback(filters.concat(customFilters));
                    });
                } else {
                    errorCallback();
                }
            });
        };

        /**
         * Method is called after we have got server response
         * Now we check filters version and update filter if needed
         * @param success
         * @param filterMetadataList
         */
        const onLoadFilterMetadataList = (success, filterMetadataList) => {
            if (success) {
                const filterMetadataListToUpdate = [];
                for (let i = 0; i < filterMetadataList.length; i += 1) {
                    const filterMetadata = filterMetadataList[i];
                    const filter = subscriptions.getFilter(filterMetadata.filterId);
                    // eslint-disable-next-line max-len
                    if (filter && filterMetadata.version && browserUtils.isGreaterVersion(filterMetadata.version, filter.version)) {
                        log.info(`Updating filter ${filter.filterId} to version ${filterMetadata.version}`);
                        filterMetadataListToUpdate.push(filterMetadata);
                    } else {
                        // remember that this filter version was checked
                        filter.lastCheckTime = Date.now();
                    }
                }
                loadFiltersFromBackendCallback(filterMetadataListToUpdate);
            } else {
                errorCallback();
            }
        };

        // Retrieve current filters metadata for update
        loadFiltersMetadataFromBackend(filterIdsToUpdate, onLoadFilterMetadataList);
    };

    // Scheduling job
    let scheduleUpdateTimeoutId;
    function scheduleUpdate() {
        const checkTimeout = 1000 * 60 * 30;
        if (scheduleUpdateTimeoutId) {
            clearTimeout(scheduleUpdateTimeoutId);
        }

        // don't update filters if filters update period is equal to 0
        if (filtersUpdatePeriod === 0) {
            return;
        }

        scheduleUpdateTimeoutId = setTimeout(() => {
            try {
                checkAntiBannerFiltersUpdate();
            } catch (ex) {
                log.error('Error update filters, cause {0}', ex);
            }
            scheduleUpdate();
        }, checkTimeout);
    }

    /**
     * Schedules filters update job
     *
     * @param isFirstRun App first run flag
     * @private
     */
    function scheduleFiltersUpdate(isFirstRun) {
        filtersUpdatePeriod = settings.getFiltersUpdatePeriod();
        // First run delay
        if (isFirstRun) {
            setTimeout(checkAntiBannerFiltersUpdate, UPDATE_FILTERS_DELAY, isFirstRun);
        }

        scheduleUpdate();
    }

    return {
        checkAntiBannerFiltersUpdate,
        scheduleFiltersUpdate,
        loadFilterRules,
    };
})();