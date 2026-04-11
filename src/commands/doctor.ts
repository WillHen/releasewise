import { defineCommand } from 'citty';

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description:
      'Verify setup: git repo, provider reachable, gh installed, config valid.',
  },
  async run() {
    console.log('releasewise doctor — not yet implemented (step 17)');
  },
});
