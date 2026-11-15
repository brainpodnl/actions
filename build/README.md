# Brainpod build action

Builds a repository's images with [steiger](https://github.com/brainhivenl/steiger), pushes them to the Brainpod registry and reports the Build to Brainpod, where it can be followed live with its log.

Reference it as `brainpodnl/actions/build@v1`. It runs steiger itself, rather than through [`brainhivenl/steiger-action`](https://github.com/brainhivenl/steiger-action), because it follows steiger's output to stream the Build's log and phase to Brainpod.

There are no secrets to configure. The action signs in with the workflow's GitHub OIDC token, which Brainpod exchanges for a short-lived key bound to the Pod. Brainpod accepts it only from the repository linked to the Pod, and only for its base branch, the `brainpod/onboarding-<pod>` branch and `v*` tags.

## Usage

```yaml
name: Brainpod shop
on:
  push:
    branches: ["main", "brainpod/onboarding-shop"]
    tags: ["v*"]
permissions:
  contents: read
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: brainpodnl/actions/build@v1
        with:
          pod: shop
          api-url: https://api.brainpod.io
          registry: registry.brainpod.io
```

The job needs `permissions: id-token: write`; without it GitHub doesn't issue the OIDC token and the step fails.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `pod` | yes | | Name of the Pod the images belong to. |
| `api-url` | yes | | Brainpod API server URL. The action calls `<api-url>/oidc/github/token` and `<api-url>/builds`. |
| `registry` | yes | | Brainpod registry host. Images are pushed to `<registry>/<pod>/<name>`. |
| `config` | no | `steiger.yml` | steiger configuration, relative to the workspace. |
| `audience` | no | `api-url` | Audience of the GitHub OIDC token; must match the audience Brainpod expects. |
| `steiger-version` | no | `v0.0.7` | steiger release to download. |
| `normalise` | no | `true` | Rebuild images that run as root (see below). |

## Outputs

| Output | Description |
| --- | --- |
| `build-id` | ID of the Brainpod Build. |
| `artifacts` | JSON object mapping each artifact name to its digest-pinned image reference. |

## What it does

1. Requests a GitHub OIDC token for `audience`, exchanges it at `<api-url>/oidc/github/token` and masks the returned key.
2. Runs `docker login <registry> -u <pod> --password-stdin`.
3. Creates the Build (`POST /builds`) with the `git.rev`, `git.refname`, `github.repo` and `github.workflow` tags and the workflow run as its source, then reports it as started.
4. Downloads steiger (cached in the runner's tool cache) and runs `steiger --config <config> build --repo <registry>/<pod> --output-file …`. The runner's `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_CACHE_URL` and `ACTIONS_RESULTS_URL` are passed on, so `--cache-from/--cache-to type=gha` in `steiger.yml` work. The output goes to the job log and to the Build's log in Brainpod (sent every 2 seconds or 32 KiB).
5. For each artifact, pulls the digest-pinned image and reads its config with `docker image inspect`. If the image runs as root (no `User`, `0` or `root`), its `WorkingDir` is not `/` and that directory is not owned by uid 1000, it rebuilds it with the default Docker builder as `FROM <image>`, `chown -R 1000:1000 <WorkingDir>`, `USER 1000:1000`, pushes it as `<registry>/<pod>/<name>:<tag>-brainpod` and uses that digest. It then reports the artifact with its digest-pinned reference and image config (user, working directory, exposed ports, entrypoint, command and environment).
6. Reports the Build as completed. On any failure it reports it as failed with the reason and the end of the log, and fails the step. A cancelled run is reported as failed too.

Images are built with steiger's own `docker-container` builder. steiger pushes them with its own registry client, which uses plain HTTP only for hosts listed under `insecureRegistries` in `steiger.yml`.

## Development

The action is plain JavaScript on Node 20 without dependencies. Run the tests from this directory with:

```sh
node --test
```

Releases of this repository are tagged `vX.Y.Z`, and the `v1` tag moves to the latest `v1.x.y`.
