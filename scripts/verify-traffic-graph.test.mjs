import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Runs the real operator check, infra/compose/verify-traffic-graph.sh, against a real graph
// directory and a stand-in `docker` that answers `compose ps`, `inspect` and `network inspect`
// with recorded-shape container records. Each hostile record must make the check fail.
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const composeDirectory = join(repositoryRoot, 'infra/compose');
const verifier = join(composeDirectory, 'verify-traffic-graph.sh');
const entryScript = join(composeDirectory, 'valhalla-serve-verified.sh');
const ENGINE =
  'ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:3d7a08f7e78b356ee873b61711b743ad81bcc114b0ca5731217da8bba6ba39d1';
const PBF = 'alberta-british-columbia-261111.osm.pbf';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function graphDirectory(root) {
  const directory = join(root, 'graph');
  await mkdir(directory);
  const archive = 'tiles of the verified graph';
  const graphId = sha256(archive);
  const config = JSON.stringify({
    mjolnir: {
      tile_dir: '/nonexistent',
      tile_extract: '/graph/connected.tar',
      traffic_extract: '',
    },
  });
  const pbfSha = 'b'.repeat(64);
  const provenance = JSON.stringify({
    format: 'navoss-serving-graph-provenance',
    formatVersion: 1,
    graphId,
    servingConfigSha256: sha256(config),
    routingEngineVersion: '3.8.2',
    input: { pbf: PBF, pbfSha256: pbfSha, sha256sums: `${pbfSha}  ${PBF}\n` },
  });
  await writeFile(join(directory, 'connected.tar'), archive);
  await writeFile(join(directory, 'valhalla-serving.json'), config);
  await writeFile(join(directory, 'provenance.json'), provenance);
  await writeFile(
    join(directory, 'graph.json'),
    JSON.stringify({ graphId, routingEngineVersion: '3.8.2' }),
  );
  await writeFile(
    join(directory, 'dead-end-mask.json'),
    JSON.stringify({
      format: 'navoss-traffic-dead-end-mask',
      formatVersion: 2,
      graph: { graphId, provenanceSha256: sha256(provenance), routingEngineVersion: '3.8.2' },
      inputs: { extractPolicyVersion: 3, pbfSha256: pbfSha },
      rules: { terminalMeters: 400 },
    }),
  );
  return { directory: await realpath(directory), graphId };
}

function containers(graph) {
  const started = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, '.123456789Z');
  const valhalla = {
    Id: 'valhalla-id',
    Name: '/navoss-valhalla-1',
    Path: '/bin/sh',
    Args: ['/navoss/serve-verified-graph.sh'],
    Config: {
      Image: ENGINE,
      Entrypoint: ['/bin/sh', '/navoss/serve-verified-graph.sh'],
      Cmd: null,
      Env: [`NAVOSS_GRAPH_ID=${graph.graphId}`, 'PATH=/usr/bin'],
    },
    Mounts: [
      { Destination: '/navoss/serve-verified-graph.sh', RW: false, Source: entryScript },
      { Destination: '/graph', RW: false, Source: graph.directory },
    ],
    HostConfig: { ReadonlyRootfs: true },
    State: { Running: true, StartedAt: started, Health: { Status: 'healthy' } },
    NetworkSettings: {
      Networks: { navoss_backend: { Aliases: ['navoss-valhalla-1', 'valhalla'] } },
    },
  };
  const api = {
    Id: 'api-id',
    Name: '/navoss-api-1',
    Config: {
      Env: [
        'COMMUNITY_TRAFFIC_GRAPH_DIR=/graph',
        `COMMUNITY_TRAFFIC_GRAPH_ID=${graph.graphId}`,
        'VALHALLA_TRACE_URL=http://valhalla:8002/trace_attributes',
        'VALHALLA_URL=http://valhalla:8002/route',
      ],
    },
    Mounts: [{ Destination: '/graph', RW: false, Source: graph.directory }],
    HostConfig: { ReadonlyRootfs: true },
    State: { Running: true, StartedAt: started },
    NetworkSettings: {
      Networks: { navoss_backend: { Aliases: ['api'] }, navoss_ingress: { Aliases: ['api'] } },
    },
  };
  const other = {
    Id: 'other-id',
    Name: '/navoss-reports-db-1',
    NetworkSettings: { Networks: { navoss_backend: { Aliases: ['reports-db'] } } },
  };
  return { api, other, valhalla };
}

async function run(root, graph, change = () => {}) {
  const records = containers(graph);
  change(records);
  const fake = join(root, `docker-${String(Math.random()).slice(2)}`);
  await mkdir(fake);
  for (const record of Object.values(records)) {
    await writeFile(join(fake, `inspect-${record.Id}.json`), JSON.stringify([record]));
  }
  const members = Object.fromEntries(
    Object.values(records)
      .filter((record) => record.NetworkSettings.Networks.navoss_backend !== undefined)
      .map((record) => [record.Id, {}]),
  );
  await writeFile(
    join(fake, 'network-navoss_backend.json'),
    JSON.stringify([{ Containers: members }]),
  );
  await writeFile(
    join(fake, 'docker'),
    `#!/bin/sh
case "$1" in
  compose) for argument do last=$argument; done; echo "$last-id" ;;
  inspect) cat "${fake}/inspect-$2.json" ;;
  network) cat "${fake}/network-$3.json" ;;
  *) exit 64 ;;
esac
`,
  );
  await chmod(join(fake, 'docker'), 0o755);
  return spawnSync('sh', [verifier], {
    cwd: composeDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMMUNITY_TRAFFIC_GRAPH_ID: graph.graphId,
      NAVOSS_COMPOSE: 'docker compose',
      PATH: `${fake}:${process.env.PATH ?? ''}`,
      VALHALLA_DATA_DIR: graph.directory,
    },
  });
}

test('the operator check passes the verified stack and refuses each hostile container record', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'navoss-verify-traffic-graph-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  const graph = await graphDirectory(root);

  const valid = await run(root, graph);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /verified in the running stack/);

  // The API's matcher selected from VALHALLA_URL alone, as the traffic service selects it.
  const fallback = await run(root, graph, ({ api }) => {
    api.Config.Env = api.Config.Env.filter((entry) => !entry.startsWith('VALHALLA_TRACE_URL='));
  });
  assert.equal(fallback.status, 0, fallback.stderr);

  const refused = [
    [
      'an expected exec in a comment, then another configuration',
      ({ valhalla }) => {
        valhalla.Config.Entrypoint = [
          '/bin/sh',
          '-ec',
          '# exec valhalla_service /graph/valhalla-serving.json 2\nexec valhalla_service /graph/unverified.json 2',
        ];
        valhalla.Args = valhalla.Config.Entrypoint.slice(1);
      },
      /not the verifying valhalla_service entrypoint/,
    ],
    [
      'an extra command after the verifying entrypoint',
      ({ valhalla }) => {
        valhalla.Config.Cmd = ['/graph/unverified.json'];
        valhalla.Args = [...valhalla.Args, '/graph/unverified.json'];
      },
      /not the verifying valhalla_service entrypoint/,
    ],
    [
      'another script mounted as the entrypoint',
      ({ valhalla }) => {
        valhalla.Mounts[0].Source = join(root, 'other.sh');
      },
      /not the verifying valhalla_service entrypoint/,
    ],
    [
      'a writable graph mount',
      ({ valhalla }) => {
        valhalla.Mounts[1].RW = true;
      },
      /not the verifying valhalla_service entrypoint/,
    ],
    [
      'the API matching at another private Valhalla',
      ({ api }) => {
        api.Config.Env.push('VALHALLA_TRACE_URL=http://other-valhalla:8002/trace_attributes');
      },
      /matches traces at http:\/\/other-valhalla:8002\/trace_attributes/,
    ],
    [
      'an empty trace URL (the service uses it as set, not the fallback)',
      ({ api }) => {
        api.Config.Env.push('VALHALLA_TRACE_URL=');
      },
      /matches traces at , not/,
    ],
    [
      'the API falling back to another Valhalla',
      ({ api }) => {
        api.Config.Env = [
          ...api.Config.Env.filter((entry) => !entry.startsWith('VALHALLA_')),
          'VALHALLA_URL=http://10.0.0.9:8002/route',
        ];
      },
      /matches traces at http:\/\/10\.0\.0\.9:8002\/trace_attributes/,
    ],
    [
      'no shared network on which the inspected container is valhalla',
      ({ valhalla }) => {
        valhalla.NetworkSettings.Networks.navoss_backend.Aliases = ['navoss-valhalla-1'];
      },
      /shares no network/,
    ],
    [
      'another container also answering to valhalla',
      ({ other }) => {
        other.NetworkSettings.Networks.navoss_backend.Aliases.push('valhalla');
      },
      /another container also answers to valhalla/,
    ],
    [
      'a container started before the graph directory changed',
      ({ api }) => {
        api.State.StartedAt = '2020-01-01T00:00:00.000000000Z';
      },
      /api started before the graph directory last changed/,
    ],
  ];
  for (const [name, change, message] of refused) {
    const result = await run(root, graph, change);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, message, name);
  }
});
