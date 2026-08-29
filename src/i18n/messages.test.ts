import { describe, expect, it } from 'vitest';
import { enMessages, zhMessages } from './messages.js';

describe('public message boundary', () => {
  it('does not expose internal workspace names or host paths', () => {
    const publicMessages = Object.values({ ...zhMessages, ...enMessages }).join('\n');
    const forbiddenFragments = [
      'Haomo' + 'Kit',
      '_' + 'helper',
      '/' + 'Users' + '/',
    ];

    for (const fragment of forbiddenFragments) {
      expect(publicMessages).not.toContain(fragment);
    }
  });
});
