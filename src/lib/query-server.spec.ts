import test from 'ava';
import {queryServer} from './query-server'
test('query-server', async (t) => {
  const results = await queryServer();
  console.log({results});
  t.pass();
})
