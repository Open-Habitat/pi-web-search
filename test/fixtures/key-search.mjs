// Test-only: the shipped extension with Brave's endpoint pointed at the
// test's synthetic service, named by the test in the environment.
import { createExtension } from '../../extension.mjs';

export default createExtension({ endpoints: { brave: process.env.PI_WEB_SEARCH_TEST_BRAVE } });
