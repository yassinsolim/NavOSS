// Shared by contract/API/phone tests: missing captured data must fail, not be asserted away.
export function fixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected captured fixture value.');
  return value;
}
