/**
 * The one line of the repository's `.npmrc` a consumer install needs.
 *
 * `npm install --prefix <dir>` looks up project configuration in `<dir>`, not in
 * this repository, so a workstation `~/.npmrc` that maps the `@dvmkit` scope to a
 * private registry would decide where the scoped SDK dependency is fetched from.
 * The smoke gives the consumer that scope line and nothing else: the rest of the
 * repository file (`legacy-peer-deps`, `engine-strict`, …) shapes this
 * repository's own installs, and carrying it over would stop the smoke from
 * modelling a default machine — a peer conflict a real `npm i -g` would refuse
 * passes under `legacy-peer-deps`, while `engine-strict` turns compatibility
 * warnings into install failures.
 */
export function consumerNpmrc(repositoryNpmrc) {
  const scope = repositoryNpmrc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("@dvmkit:registry="));
  if (!scope) {
    throw new Error("repository .npmrc does not pin the @dvmkit scope registry");
  }
  return `${scope}\n`;
}
