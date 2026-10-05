export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/scripts/jest-env.cjs'],
  setupFilesAfterEnv: ['<rootDir>/scripts/jest-after-env.cjs'],
  reporters: ['default', '<rootDir>/scripts/data-guard-reporter.cjs'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
};
