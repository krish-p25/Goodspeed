module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: true, esModuleInterop: true } }],
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@kb/types$': '<rootDir>/../../packages/types/src/index.ts',
  },
}
