# Brainpod GitHub Actions

GitHub Actions for [Brainpod](https://brainpod.io).

| Action | Use | Description |
| --- | --- | --- |
| [`build`](build) | `uses: brainpodnl/actions/build@v1` | Builds a repository's images with steiger, pushes them to the Brainpod registry and reports the Build to Brainpod, signed in with the workflow's GitHub OIDC token. |

Every action of this repository shares its release tags: `vX.Y.Z`, with `v1` moving to the latest `v1.x.y`.
