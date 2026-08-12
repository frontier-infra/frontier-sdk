# @frontier-infra/create-frontier-app

Scaffold a small governed-worker app that pairs a React/Vite operator surface
with a Node server using `@frontier-infra/harness-kit`.

```sh
npx @frontier-infra/create-frontier-app@next my-frontier-app
```

During the Foundation RC, use the explicit `next` channel. The package is not
promoted to `latest` until the RC has independent consumer evidence.

The CLI refuses unsafe target directories, will not write into a non-empty
directory, and prints package-manager-neutral next steps.

The generated app is a reference starting point. Its compose files and
production configuration are illustrative and must be adapted before use in a
real deployment.
