# NativeLink cache action

This action is a drop-in replacement of the official `actions/cache@v4` action, for use with the [NativeLink Cloud](nativelink.com/?ref=cache)

it will store your cache in the CAS Server of [NativeLink Cloud](nativelink.com/?ref=cache). The current limit is 20GB but that can be increased just reach out any member of the team, the retention policy by default is ~30 days.

## Usage

Replace `actions/cache@v4` with `runs-on/cache@v4`. All the official options are supported.

```diff
- - uses: actions/cache@v4
+ - uses: chinchaun/nativelink-cache@v0.0.2-beta
    with:
      ...
```

## Usage

You need to create two secrets variables and use them as an env in the action

```yaml
  - uses: actions/checkout@v4
    ...
  - uses: chinchaun/nativelink-cache@v0.0.2-beta
    with:
      ...
    env:
      NATIVELINK_API_KEY: ${{ secrets.NATIVELINK_API_KEY }}
      NATIVELINK_REMOTE_CACHE_URL: ${{ secrets.NATIVELINK_REMOTE_CACHE_URL }}
```

Please refer to [actions/cache](https://github.com/actions/cache) for usage.

## Secrets variables
* `NATIVELINK_API_KEY`: Your API Key. You can find it in Settings -> API Keys & Certs -> ID.
* `NATIVELINK_REMOTE_CACHE_URL`: url of the remote cache. You can find it in Settings -> General -> Remote Cache, remove the grpcs with https, e.g: grpcs://url.build-faster.nativelink.net -> https://url.build-faster.nativelink.net

If you don't set these variables the action will fall back to the default GitHub actions@v4

## Environment Variables
* `VERSION_SALT (Optional)`: this allows disowning an entire set of cache key poisoned by buggy software or tool failures

## Inputs Variables
* `UploadChunkSize`: the size of the data inside the message when uploading the stream of data in KB the default value is 64KB https://github.com/grpc/grpc.github.io/issues/371#issue-174066362, this value cannot exceed 4MB, the validation value is 4 * 1024 * 1024 - 1024 which is the maximum size for a single gRPC request, minus a small delta, you can find more info here https://github.com/grpc/grpc-java/issues/1676#issuecomment-229809402
