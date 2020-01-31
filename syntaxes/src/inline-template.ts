/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {GrammarDefinition} from './types';

export const InlineTemplate: GrammarDefinition = {
  scopeName: 'inline-template.ng',
  injectionSelector: 'L:meta.decorator.ts -comment',
  patterns: [{include: '#inlineTemplate'}],
  repository: {
    inlineTemplate: {
      begin: /(template)\s*(:)/,
      beginCaptures: {
        1: {name: 'meta.object-literal.key.ts'},
        2: {name: 'meta.object-literal.key.ts punctuation.separator.key-value.ts'}
      },
      end: /(?=,|})/,
      patterns: [{include: '#tsParenExpression'}, {include: '#ngTemplate'}]
    },

    tsParenExpression: {
      begin: /\G\s*(\()/,
      beginCaptures: {1: {name: 'meta.brace.round.ts'}},
      end: /\)/,
      endCaptures: {0: {name: 'meta.brace.round.ts'}},
      patterns: [{include: '#tsParenExpression'}, {include: '#ngTemplate'}]
    },

    ngTemplate: {
      begin: /\G\s*([`|'|"])/,
      beginCaptures: {1: {name: 'string'}},
      end: /\1/,
      endCaptures: {0: {name: 'string'}},
      contentName: 'text.html',
      patterns: [{include: 'text.html.derivative'}, {include: 'template.ng'}]
    }
  }
};
