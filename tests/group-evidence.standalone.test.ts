// Failure cases: the new report or selected reading background loses evidence after character 6000;
// a very long body consumes an unbounded context; changing the body allowance damages short reports.
import './standalone.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchUser, describeReport, type ReportView } from '@aihot/backend/events/relate';

test('grouping includes late evidence from both sides within its ten-thousand-character allowance',()=>{
  const sourceText='前'.repeat(6500)+'后半部的独立分析证据'+'后'.repeat(3500)+'上限之外';
  const report:ReportView={title:'研究发布后的长文解读',source:'Example',firstParty:false,at:new Date(),summary:'概述',sourceText};
  const prompt=batchUser(report,[],'新报道',[{report:{...report,sourceText:null},sourceText}]);
  assert.equal(prompt.split('后半部的独立分析证据').length-1,2);
  assert.ok(!prompt.includes('上限之外'));
  assert.ok(describeReport({...report,sourceText:'短正文'},'新报道').includes('短正文'));
});
