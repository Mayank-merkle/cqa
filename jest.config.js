/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tools/cqa'],
  // These are graph-resolution fixtures for the engine's own tests, not test
  // suites themselves — same gotcha as dotcomV2's own jest.config.js.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tools/cqa/__tests__/fixtures/']
};
