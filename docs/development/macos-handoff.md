# macOS development handoff

This runbook moves NavOSS development to another Mac without treating chat history, caches, or generated files as project state.

## Canonical state

GitHub is the source of truth for source, decisions, agent context, and release records:

- Repository: `https://github.com/yassinsolim/NavOSS.git`
- Branch: `main`
- Build 26 release-record checkpoint: `a3cbb5ed4d59867ca078e8ceef056ede7ed21bb0`
- Agent context: root `AGENTS.md`, automatically loaded by oh-my-pi
- Release state: `docs/release/testflight.md`
- CarPlay architecture: `docs/architecture/carplay.md`

Clone the latest `origin/main`; it includes the release checkpoint and this handoff. On the new Mac, verify that `git rev-parse HEAD` and `git rev-parse origin/main` agree before starting work.

## New Mac bootstrap

1. Install Xcode 26.6 or a compatible full Xcode release, open it once, accept the license, and install the iOS 26.5 simulator runtime.
2. Install Homebrew, `mise`, CocoaPods 1.17.0, Maestro 2.6.1, GitHub CLI, and oh-my-pi.
3. Authenticate separately with GitHub, Expo/EAS, Apple Developer/Xcode, App Store Connect, and the production VM. Do not copy tokens or private keys through Git.
4. Clone and bootstrap:

Install oh-my-pi using its official Homebrew tap and verify the CLI:

```sh
brew install can1357/tap/omp
omp --version
```

```sh
gh auth login
gh repo clone yassinsolim/NavOSS
cd NavOSS

git config user.name "Yassin Soliman"
git config user.email "solimanyassin@gmail.com"
git config pull.ff only

mise install
corepack enable
corepack pnpm install --frozen-lockfile

git fetch origin
git switch main
git pull --ff-only
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
corepack pnpm check
corepack pnpm test
```

Use `git commit --signoff` for every commit. The signoff uses the configured legal identity above. Authenticate `gh` as `yassinsolim` and EAS as `yassinsolim`; credentials remain in each tool's keychain/configuration.

For Xcode commands, ensure the full Xcode installation is selected:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcodebuild -version
pod --version
```

If `sudo` is undesirable, prefix individual commands with:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

## Production access

The old Mac has an SSH alias named `navoss-prod` for `navoss@192.168.1.74`. Recreate access with a new SSH key rather than copying the old private key:

```sh
ssh-keygen -t ed25519 -C "solimanyassin@gmail.com"
```

Add the new public key to the server through an already authorized session, then add this local configuration:

```sshconfig
Host navoss-prod
  HostName 192.168.1.74
  User navoss
  IdentityFile ~/.ssh/id_ed25519
```

Do not commit the production `.env`, Cloudflare credentials, Apple signing material, GitHub tokens, or Expo tokens. Re-authenticate using the providers' normal login flows and Keychain storage.

## Optional local evidence transfer

The ignored `artifacts/` directory is about 88 MB. It is not required to build the project, but it contains signed IPAs and validation evidence worth retaining. Copy it with AirDrop, encrypted external storage, or `rsync`; never add it to Git.

A ready-to-transfer archive exists on the old Mac at:

```text
/Users/ysoli/NavOSS/artifacts/navoss-handoff-2026-07-29.tar.gz
```

Its SHA-256 checksum is:

```text
160899feee732c49509ba5d00fc9b3f732c63b2946cc799fbe7b886aaa1c35aa
```

After transferring it, extract from the new repository root:

```sh
shasum -a 256 navoss-handoff-2026-07-29.tar.gz
tar -xzf navoss-handoff-2026-07-29.tar.gz
```

From the new Mac, with Remote Login enabled temporarily on the old Mac:

```sh
mkdir -p artifacts
rsync -a --info=progress2 OLD_MAC_HOST:/Users/ysoli/NavOSS/artifacts/ ./artifacts/
shasum -a 256 artifacts/releases/navoss-build26.ipa
```

Expected build 26 checksum:

```text
c59f1e40669c9f93ec17a1e7debdcaceca47fa6fd3153afe7be6d26574074950
```

Do not transfer `node_modules`, `.turbo`, `.expo`, `apps/mobile/ios`, `DerivedData`, CocoaPods output, or `.playwright-mcp/`. They are caches, generated output, or local browser evidence and should be recreated only when needed.

## First oh-my-pi session

Start oh-my-pi from the repository root so it discovers `AGENTS.md`. A useful first prompt is:

```text
Read the loaded NavOSS project context and verify the repository is on main at
origin/main. Summarize the current TestFlight/CarPlay checkpoint from
docs/release/testflight.md, then continue with build 26 processing and physical
CarPlay validation. Do not rebuild unless build 26 was rejected.
```

Before editing, the agent should report:

- local and remote commit IDs;
- dirty or untracked files;
- the current build and submission IDs;
- the focused validation command for the proposed change.

## Routine Git workflow

```sh
git switch main
git pull --ff-only
git switch -c <type>/<short-topic>

# edit and run focused checks
git status --short
git diff --check
git add <explicit-files>
git diff --cached
git commit --signoff -m "<type>(<scope>): <summary>"
git push -u origin HEAD
```

Do not use `git add .` for release work. Stage explicit files so ignored artifacts and unrelated local changes cannot enter a commit. Merge through GitHub after checks, then fast-forward local `main`.

## Current release continuation

Build `0.1.0 (26)` is the candidate to continue. It was uploaded under EAS submission `a8d7e2de-a355-46d9-acc5-889cff6517f9`. Do not rebuild merely because development moved Macs.

The remaining sequence is:

1. Check Apple processing and attach build 26 to internal `testers`.
2. Install that exact build through TestFlight.
3. Validate parked Search, Settings, Light/Dark/Automatic, All guidance, Alerts only, Muted, private reports, active controls, overview/follow, arrow orientation, and reconnect continuity on real CarPlay.
4. Record evidence in `docs/release/testflight.md` and commit it with signoff.
