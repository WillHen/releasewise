import { defineCommand } from 'citty';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Detect the project and write a .releasewise.json config.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite existing config if present',
      default: false,
    },
  },
  async run() {
    console.log('releasewise init — not yet implemented (step 16)');
  },
});
