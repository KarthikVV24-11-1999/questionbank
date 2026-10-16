/**
 * Not production code. Planted violation: review plumbing reaching `platform/`
 * for something other than the role vocabulary. The ADR-0026 exemption is one
 * exact path, not the directory.
 */
import { createApplication } from '../../../../platform/composition/app-factory.js';

export const reachesPlatform = createApplication;
