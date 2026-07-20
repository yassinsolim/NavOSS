# Domain Layout

NavOSS uses an app-scoped namespace under `yassin.app` so future projects can use the same pattern without collisions.

| Host                       | Purpose                                                  | Target                                             |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `navoss.yassin.app`        | Product, privacy, support, attribution, and source links | Dedicated Vercel project                           |
| `api.navoss.yassin.app`    | Versioned mobile API                                     | Stable backend ingress; not Vercel-hosted Valhalla |
| `status.navoss.yassin.app` | Public service status                                    | Reserved for a later independent status provider   |

Future apps can use `<app>.yassin.app`, `api.<app>.yassin.app`, and `status.<app>.yassin.app`.

## Website

Create a separate Vercel project from the NavOSS repository for the public site, then add `navoss.yassin.app` under **Project > Settings > Domains**. Cloudflare remains authoritative DNS, so add the CNAME target shown by Vercel.

The site must publish these stable routes before TestFlight:

- `/privacy`
- `/support`
- `/data-sources`
- `/licenses`

## API

`api.navoss.yassin.app` must point to the backend ingress, not the static Vercel project. Vercel can host the public documentation site, but the regional Valhalla/search stack requires an always-on container or VM with persistent artifacts and measured capacity.

For a temporary private device test, a Cloudflare Tunnel can terminate HTTPS and forward the hostname to the API on the development Mac. That still depends on the Mac remaining online and does not qualify as a production TestFlight backend.

Before embedding the API hostname in a release:

```sh
curl --fail https://api.navoss.yassin.app/health
curl --fail https://api.navoss.yassin.app/ready
EXPO_PUBLIC_API_URL=https://api.navoss.yassin.app \
  corepack pnpm --filter @navoss/mobile validate:release
```

## Email

The preferred public alias is `navoss@yassin.app`, forwarded privately to the maintainer's mailbox through Cloudflare Email Routing. It is not active until Cloudflare adds the required MX/SPF/DKIM records, the destination mailbox is verified, and a message from another account is delivered successfully.

Do not publish the maintainer's personal mailbox in source history. Use GitHub Issues and private vulnerability reporting until the alias passes its delivery test.
