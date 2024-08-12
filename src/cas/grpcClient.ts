import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import {
    Code,
    ConnectError,
    createPromiseClient,
    Interceptor
} from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

import { ActionCache } from "./gen/build/bazel/remote/execution/v2/remote_execution_connect";
import {
    ActionResult,
    Digest,
    UpdateActionResultRequest
} from "./gen/build/bazel/remote/execution/v2/remote_execution_pb";
import { ByteStream } from "./gen/google/bytestream/bytestream_connect";
import {
    ReadResponse,
    WriteRequest,
    WriteResponse
} from "./gen/google/bytestream/bytestream_pb";

// Maximum size for a single gRPC request, minus a small delta:
// https://github.com/grpc/grpc-java/issues/1676#issuecomment-229809402
export const MAX_GRPC_REQUEST_SIZE = 4 * 1024 * 1024 - 1024;
// recommended message size
// https://github.com/grpc/grpc.github.io/issues/371#issue-174066362
export const MESSAGE_SIZE = 64 * 1024;

const remoteCacheUrl = process.env["NATIVELINK_REMOTE_CACHE_URL"];
const apiKey = process.env["NATIVELINK_API_KEY"];

export const isNativeLinkEnabled = () => {
    return remoteCacheUrl !== undefined && apiKey !== undefined;
};

const addHeaders: Interceptor = next => {
    if (!apiKey) {
        throw new Error(
            "Environment variable NATIVELINK_API_KEY parameter is missing"
        );
    }
    return async req => {
        try {
            req.header.append("x-nativelink-api-key", apiKey);
            // TODO: removed this when the content-type: application/grpc+proto support is deployed
            req.header.delete("content-type");
            req.header.append("content-type", "application/grpc");
            const res = await next(req);
            return res;
        } catch (err) {
            const cErr = ConnectError.from(err);
            throw cErr;
        }
    };
};

const transport = createGrpcTransport({
    baseUrl: "https://cas-chinchaun.build-faster.nativelink.net",
    httpVersion: "2",
    interceptors: [addHeaders]
});

const byteStreamClient = createPromiseClient(ByteStream, transport);
const actionCacheClient = createPromiseClient(ActionCache, transport);

export async function saveCache(params: {
    key: string;
    paths: string[];
    archivePath: string;
    compressionMethod: CompressionMethod;
    enableCrossOsArchive: boolean;
    archiveFileSize: number;
    uploadChunkSize: number | undefined;
}): Promise<void> {
    const {
        key,
        paths,
        archivePath,
        compressionMethod,
        enableCrossOsArchive,
        archiveFileSize,
        uploadChunkSize
    } = params;
    core.debug(`params: ${params}`);

    if (!remoteCacheUrl) {
        throw new Error(
            "Environment variable NATIVELINK_REMOTE_CACHE_URL parameter is missing"
        );
    }

    if (!apiKey) {
        throw new Error(
            "Environment variable NATIVELINK_API_KEY parameter is missing"
        );
    }

    // Cache
    core.info(
        `Cache Size: ~${Math.round(
            archiveFileSize / (1024 * 1024)
        )} MB (${archiveFileSize} B)`
    );

    const fileHash = getCacheVersion({
        paths,
        compressionMethod,
        enableCrossOsArchive
    });

    const file = new FileAsyncIterable({
        filePath: archivePath,
        fileHash,
        fileByteLength: archiveFileSize,
        uploadChunkSize: uploadChunkSize
    });

    let writeResult: WriteResponse;
    try {
        writeResult = await byteStreamClient.write(file);
    } catch (err) {
        let errMsg = "Failed to upload file";
        if (err instanceof ConnectError) {
            errMsg = `${errMsg} code error: ${Code[err.code]}, reason: ${
                err.rawMessage
            }`;
        }
        core.error(errMsg);
        throw err;
    }

    if (writeResult.committedSize < archiveFileSize) {
        throw new Error(
            "The upload process failed to send the entire file content"
        );
    }

    core.debug(
        `File saved with hash: ${fileHash}, fileByteLength: ${archiveFileSize}`
    );

    const keyHash = getCacheVersion({
        paths,
        compressionMethod,
        enableCrossOsArchive,
        key
    });

    const actionResult = new ActionResult({
        outputFiles: [
            {
                path: archivePath,
                digest: file.digest
            }
        ]
    });

    const updateActionResultRequest = new UpdateActionResultRequest({
        actionResult: actionResult,
        actionDigest: {
            hash: keyHash
        }
    });

    try {
        await actionCacheClient.updateActionResult(updateActionResultRequest);
        core.debug(`saved action with hash: ${keyHash}`);
    } catch (err) {
        let errMsg = "Failed to upload action result";
        if (err instanceof ConnectError) {
            errMsg = `${errMsg} code error: ${Code[err.code]}, reason: ${
                err.rawMessage
            }`;
        }
        core.error(errMsg);
        throw err;
    }
}

class FileAsyncIterable implements AsyncIterable<WriteRequest> {
    private readonly filePath: string;
    private readonly fileByteLength: number;
    private readonly fileHash: string;
    private readonly chunkSize: number;
    readonly digest: Digest;

    constructor(data: {
        filePath: string;
        fileByteLength: number;
        fileHash: string;
        uploadChunkSize: number | undefined;
    }) {
        this.filePath = data.filePath;
        this.fileByteLength = data.fileByteLength;
        this.fileHash = data.fileHash;
        this.digest = new Digest({
            hash: this.fileHash,
            sizeBytes: BigInt(this.fileByteLength)
        });
        this.chunkSize = data.uploadChunkSize || MESSAGE_SIZE;
    }

    async *[Symbol.asyncIterator]() {
        // /uploads/{uuid}/blobs/{digest_function/}{hash}/{size}{/optional_metadata}
        // TODO: Implemented metadata last_modified so when retrying stale cache by restore keys
        // the LRU can be downloaded
        const resourceName = `/uploads/${crypto.randomUUID()}/blobs/${
            this.digest.hash
        }/${this.fileByteLength}`;

        core.debug(`resource name to upload file: ${resourceName}`);
        const readableStream = createReadStream(this.filePath, {
            highWaterMark: this.chunkSize
        });

        let offset = 0;
        let remaining = this.fileByteLength - offset;

        for await (const chunk of readableStream) {
            const chunk_size = Math.min(remaining, this.chunkSize);
            remaining -= chunk_size;

            const request = new WriteRequest({
                resourceName: resourceName,
                data: new Uint8Array(chunk),
                writeOffset: BigInt(offset),
                finishWrite: remaining <= 0
            });

            yield request;
            core.info(
                `Remaining ~${Math.round(
                    remaining / (1024 * 1024)
                )} MB to upload of the total size of: ${Math.round(
                    this.fileByteLength / (1024 * 1024)
                )}`
            );

            offset += chunk_size;
        }
    }
}

// GitHub Implementations

const versionSalt = process.env["VERSION_SALT"] || "1.0";
function getCacheVersion({
    paths,
    compressionMethod,
    enableCrossOsArchive = false,
    key
}: {
    paths: string[];
    compressionMethod?: CompressionMethod;
    enableCrossOsArchive: boolean;
    key?: string;
}): string {
    // don't pass changes upstream
    const components = paths.slice();

    // Add compression method to cache version to restore
    // compressed cache as per compression method
    if (compressionMethod) {
        components.push(compressionMethod);
    }

    // Only check for windows platforms if enableCrossOsArchive is false
    if (process.platform === "win32" && !enableCrossOsArchive) {
        components.push("windows-only");
    }

    if (key) {
        components.push(key);
    }

    // Add salt to cache version to support breaking changes in cache entry
    components.push(versionSalt);

    return createHash("sha256").update(components.join("|")).digest("hex");
}

export interface ArtifactCacheEntry {
    cacheKey?: string;
    scope?: string;
    cacheVersion?: string;
    creationTime?: string;
    archiveLocation?: string;
}

export async function getCacheEntry({
    paths,
    primaryKey,
    restoreKeys,
    compressionMethod,
    enableCrossOsArchive = false
}: {
    paths: string[];
    primaryKey: string;
    restoreKeys?: string[];
    compressionMethod: CompressionMethod;
    enableCrossOsArchive: boolean;
}): Promise<Digest | undefined> {
    const primaryKeyHash = getCacheVersion({
        paths,
        enableCrossOsArchive,
        compressionMethod,
        key: primaryKey
    });

    try {
        core.debug(
            `looking for primary cache key: ${primaryKey} and hash: ${primaryKeyHash}`
        );
        const primaryActionResult = await actionCacheClient.getActionResult({
            actionDigest: {
                hash: primaryKeyHash
            }
        });
        if (primaryActionResult.outputFiles.length == 0) {
            throw new Error(
                `Action result with primaryKeyHash: ${primaryKeyHash} doesn't contain any file`
            );
        }

        return primaryActionResult.outputFiles[0].digest;
    } catch (err) {
        let errMsg = `Failed to retrieve action result for primaryKeyHash: ${primaryKeyHash}`;
        if (err instanceof ConnectError) {
            if (err.code != Code.NotFound) {
                errMsg = `${errMsg} code error: ${Code[err.code]}, reason: ${
                    err.rawMessage
                }`;
                core.error(errMsg);
            }
        } else {
            core.error(errMsg);
            throw err;
        }
    }

    if (!restoreKeys || restoreKeys.length == 0) {
        return undefined;
    }

    core.debug("primary key no found looking for restore keys");
    core.debug(`restoreKeys: ${restoreKeys}`);

    const proms = await Promise.all(
        getActionResultProms({
            paths,
            restoreKeys,
            compressionMethod,
            enableCrossOsArchive
        })
    );

    let hasError = false;
    let errMsg = "";
    for (const p of proms) {
        if (p instanceof ActionResult && p.outputFiles.length > 0) {
            return p.outputFiles[0].digest;
        } else if (p instanceof ConnectError) {
            if (p.code != Code.NotFound) {
                hasError = true;
                errMsg += `error code: ${Code[p.code]}, message: ${
                    p.rawMessage
                }`;
            }
        } else {
            hasError = true;
            errMsg += (p as Error).message;
        }
    }

    if (hasError) {
        throw new Error(errMsg);
    }

    return;
}

function getActionResultProms({
    paths,
    restoreKeys,
    compressionMethod,
    enableCrossOsArchive = false
}: {
    paths: string[];
    restoreKeys: string[];
    compressionMethod: CompressionMethod;
    enableCrossOsArchive: boolean;
}) {
    const proms: Promise<ActionResult | ConnectError | Error>[] = [];

    for (const key of restoreKeys) {
        const keyHash = getCacheVersion({
            paths,
            enableCrossOsArchive,
            compressionMethod,
            key: key
        });
        proms.push(
            actionCacheClient
                .getActionResult({
                    actionDigest: {
                        hash: keyHash
                    }
                })
                .catch(err => err)
        );
    }
    return proms;
}

export async function downloadCache({
    blobDigest,
    archivePath
}: {
    blobDigest: Digest;
    archivePath: string;
}) {
    try {
        const res = byteStreamClient.read({
            resourceName: `blobs/${blobDigest.hash}/${blobDigest.sizeBytes}`
        });

        await writeToFile(res, archivePath);
    } catch (err) {
        let errMsg = "Failed to download blob";
        if (err instanceof ConnectError) {
            errMsg = `${errMsg} code error: ${Code[err.code]}, reason: ${
                err.rawMessage
            }`;
        }
        core.error(errMsg);
        throw err;
    }
}

async function writeToFile(
    asyncIterable: AsyncIterable<ReadResponse>,
    filePath: string
) {
    const writeStream = createWriteStream(filePath);
    const transformStream = new Transform({
        transform(chunk: Uint8Array, _, callback) {
            callback(null, Buffer.from(chunk));
            return;
        }
    });
    const yieldResponseData = async function* () {
        for await (const response of asyncIterable) {
            yield response.data;
        }
    };
    await pipeline(yieldResponseData, transformStream, writeStream);
}
