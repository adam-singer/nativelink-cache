import * as utils from "@actions/cache/lib/internal/cacheUtils";
import {
    createTar,
    extractTar,
    listTar
} from "@actions/cache/lib/internal/tar";
import { DownloadOptions } from "@actions/cache/lib/options";
import * as core from "@actions/core";
import * as path from "path";

import { GrpcClient, MAX_GRPC_REQUEST_SIZE } from "./grpcClient";

const fileSizeLimit = 20 * 1024 * 1024 * 1024; // 20GB per repo limit this can be increased

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class ReserveCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReserveCacheError";
        Object.setPrototypeOf(this, ReserveCacheError.prototype);
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new ValidationError(
            `Path Validation Error: At least one directory or file path is required`
        );
    }
}

function checkKey(key: string): void {
    if (key.length > 512) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot contain commas.`
        );
    }
}

export interface ISaveCache {
    paths: string[];
    key: string;
    enableCrossOsArchive: boolean;
    uploadChunkSize: number | undefined;
}

export class CasCacheService {
    private readonly grpcClient: GrpcClient;
    constructor() {
        this.grpcClient = new GrpcClient();
    }
    /**
     * Restores cache from keys
     *
     * @param paths a list of file paths to restore from the cache
     * @param primaryKey an explicit key for restoring the cache
     * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
     * @param downloadOptions cache download options
     * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
     * @returns string returns the key for the cache hit, otherwise returns undefined
     */
    async restoreCache(
        paths: string[],
        primaryKey: string,
        restoreKeys?: string[],
        options?: DownloadOptions,
        enableCrossOsArchive = false
    ): Promise<string | undefined> {
        checkPaths(paths);

        restoreKeys = restoreKeys || [];
        const keys = [primaryKey, ...restoreKeys];

        core.debug("Resolved Keys:");
        core.debug(JSON.stringify(keys));

        if (keys.length > 10) {
            throw new ValidationError(
                `Key Validation Error: Keys are limited to a maximum of 10.`
            );
        }
        for (const key of keys) {
            checkKey(key);
        }

        const compressionMethod = await utils.getCompressionMethod();
        let archivePath = "";
        try {
            // path are needed to compute version
            const cacheEntry = await this.grpcClient.getCacheEntry({
                paths,
                primaryKey,
                restoreKeys,
                compressionMethod,
                enableCrossOsArchive
            });
            if (!cacheEntry) {
                // Cache not found
                return undefined;
            }

            if (options?.lookupOnly) {
                core.info("Lookup only - skipping download");
                return cacheEntry.hash;
            }

            archivePath = path.join(
                await utils.createTempDirectory(),
                utils.getCacheFileName(compressionMethod)
            );
            core.debug(`Archive Path: ${archivePath}`);

            // Download the cache from the cache entry
            await this.grpcClient.downloadCache({
                blobDigest: cacheEntry,
                archivePath
            });

            if (core.isDebug()) {
                await listTar(archivePath, compressionMethod);
            }

            const archiveFileSize =
                utils.getArchiveFileSizeInBytes(archivePath);
            core.info(
                `Cache Size: ~${Math.round(
                    archiveFileSize / (1024 * 1024)
                )} MB (${archiveFileSize} B)`
            );

            await extractTar(archivePath, compressionMethod);
            core.info("Cache restored successfully");

            return cacheEntry.hash;
        } catch (error) {
            const typedError = error as Error;
            if (typedError.name === ValidationError.name) {
                throw error;
            } else {
                // Suppress all non-validation cache related errors because caching should be optional
                core.warning(`Failed to restore: ${(error as Error).message}`);
            }
        } finally {
            // Try to delete the archive to save space
            try {
                await utils.unlinkFile(archivePath);
            } catch (error) {
                core.debug(`Failed to delete archive: ${error}`);
            }
        }

        return undefined;
    }

    /**
     * Saves a list of files with the specified key
     *
     * @param paths a list of file paths to be cached
     * @param key an explicit key for restoring the cache
     * @param enableCrossOsArchive an optional boolean enabled to save cache on windows which could be restored on any platform
     * @param options cache upload options
     * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
     */
    async saveCache({
        paths,
        key,
        enableCrossOsArchive = false,
        uploadChunkSize
    }: ISaveCache): Promise<number> {
        if (uploadChunkSize && uploadChunkSize * 1024 > MAX_GRPC_REQUEST_SIZE) {
            throw new ValidationError(
                `UploadChunkSize input cannot exceed the value of: ${MAX_GRPC_REQUEST_SIZE} MB`
            );
        }
        checkPaths(paths);
        checkKey(key);

        const compressionMethod = await utils.getCompressionMethod();
        let cacheId = -1;

        const cachePaths = await utils.resolvePaths(paths);
        core.debug("Cache Paths:");
        core.debug(`${JSON.stringify(cachePaths)}`);

        if (cachePaths.length === 0) {
            throw new ValidationError(
                `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
            );
        }

        const archiveFolder = await utils.createTempDirectory();
        const archivePath = path.join(
            archiveFolder,
            utils.getCacheFileName(compressionMethod)
        );

        core.debug(`Archive Path: ${archivePath}`);

        try {
            await createTar(archiveFolder, cachePaths, compressionMethod);
            if (core.isDebug()) {
                await listTar(archivePath, compressionMethod);
            }
            const archiveFileSize =
                utils.getArchiveFileSizeInBytes(archivePath);
            core.debug(`File Size: ${archiveFileSize}`);

            if (archiveFileSize > fileSizeLimit && !utils.isGhes()) {
                throw new Error(
                    `Cache size of ~${Math.round(
                        archiveFileSize / (1024 * 1024)
                    )} MB (${archiveFileSize} B) is over the 20GB limit, not saving cache.`
                );
            }

            await this.grpcClient.saveCache({
                key,
                paths,
                archiveFileSize,
                archivePath,
                compressionMethod,
                enableCrossOsArchive,
                uploadChunkSize
            });

            // this value is set to preserve the API compatibility with the base action
            cacheId = 1;
        } catch (error) {
            const typedError = error as Error;
            if (typedError.name === ValidationError.name) {
                throw error;
            } else if (typedError.name === ReserveCacheError.name) {
                core.info(`Failed to save: ${typedError.message}`);
            } else {
                core.warning(`Failed to save: ${typedError.message}`);
            }
        } finally {
            // Try to delete the archive to save space
            try {
                await utils.unlinkFile(archivePath);
            } catch (error) {
                core.debug(`Failed to delete archive: ${error}`);
            }
        }

        return cacheId;
    }
}
