import { defineCommand } from 'citty';

export const undoCommand = defineCommand({
  meta: {
    name: 'undo',
    description: 'Revert the last local (unpushed) release.',
  },
  async run() {
    console.log('releasewise undo — not yet implemented (step 13)');
  },
});
