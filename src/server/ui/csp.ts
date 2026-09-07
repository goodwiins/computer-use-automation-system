import { config } from 'zod/v4/core';

// Configure before SDK schemas load: its optional JIT probe violates strict CSP.
config({ jitless: true });
