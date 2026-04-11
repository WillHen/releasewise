import { defineCommand } from 'citty';

export const estimateCommand = defineCommand({
  meta: {
    name: 'estimate',
    description: 'Print AI token + cost estimate for the current diff.',
  },
  async run() {
    console.log('releasewise estimate — not yet implemented (step 15)');
  },
});
