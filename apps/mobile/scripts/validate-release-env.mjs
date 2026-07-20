const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

function fail(message) {
  console.error(`Release configuration error: ${message}`);
  process.exit(1);
}

if (!configuredApiUrl) {
  fail('EXPO_PUBLIC_API_URL is required.');
}

let apiUrl;

try {
  apiUrl = new URL(configuredApiUrl);
} catch {
  fail('EXPO_PUBLIC_API_URL must be a valid absolute URL.');
}

if (apiUrl.protocol !== 'https:') {
  fail('EXPO_PUBLIC_API_URL must use HTTPS.');
}

const hostname = apiUrl.hostname.toLowerCase();
const ipv4Parts = hostname.split('.').map(Number);
const isPrivateIpv4 =
  ipv4Parts.length === 4 &&
  ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
  (ipv4Parts[0] === 10 ||
    ipv4Parts[0] === 127 ||
    (ipv4Parts[0] === 169 && ipv4Parts[1] === 254) ||
    (ipv4Parts[0] === 172 && ipv4Parts[1] >= 16 && ipv4Parts[1] <= 31) ||
    (ipv4Parts[0] === 192 && ipv4Parts[1] === 168));
const isPrivateIpv6 =
  hostname === '[::1]' ||
  hostname === '::1' ||
  hostname.startsWith('[fc') ||
  hostname.startsWith('[fd') ||
  hostname.startsWith('[fe8');

if (
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname.endsWith('.local') ||
  isPrivateIpv4 ||
  isPrivateIpv6
) {
  fail('EXPO_PUBLIC_API_URL must be publicly reachable for TestFlight users.');
}

console.log(`Release API validated: ${apiUrl.origin}`);
