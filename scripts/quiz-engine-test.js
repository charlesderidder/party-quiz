'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const QuizEngine = require('../lib/QuizEngine');
const FileImporter = require('../lib/FileImporter');

const question = id => ({
  id, question: 'Vraag?', options: ['A', 'B', 'C', 'D'],
  correctIndex: 1, timeLimit: 20, points: 1000
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function createGame(t, questions = [question('one'), question('two')]) {
  const game = new QuizEngine({});
  t.after(() => game._clearTimers());
  game.selectQuizForLobby({ id: 'quiz', title: 'Quiz', questions });
  return game;
}

test('disconnecting an old socket does not disconnect a reconnected player', t => {
  const game = createGame(t);
  game.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'old' });
  game.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'new' });
  game.handleDisconnect('old');
  assert.equal(game.players.get('player').connected, true);
  game.handleDisconnect('new');
  assert.equal(game.players.get('player').connected, false);
});

test('multiple authenticated sockets remain usable until each disconnects', t => {
  const game = createGame(t);
  game.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'old' });
  game.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'new' });
  assert.equal(game.socketToPlayer.get('old'), 'player');
  game.handleDisconnect('new');
  assert.equal(game.players.get('player').connected, true);
  assert.equal(game.players.get('player').socketId, 'old');
  game.handleDisconnect('old');
  assert.equal(game.players.get('player').connected, false);
});

test('an all-answered timer cannot close the following question', async t => {
  const game = createGame(t);
  game.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'one' });
  game.nextStep();
  assert.equal(game.submitAnswer('player', 1).accepted, true);
  game.nextStep();
  game.nextStep();
  await pause(750);
  assert.equal(game.phase, 'question');
  assert.equal(game.currentQuestionIndex, 1);
});

test('newly connected players can still answer before automatic reveal', async t => {
  const game = createGame(t);
  game.joinOrReconnectPlayer({ playerId: 'first', name: 'Eerste', socketId: 'one' });
  game.nextStep();
  game.submitAnswer('first', 1);
  game.joinOrReconnectPlayer({ playerId: 'second', name: 'Tweede', socketId: 'two' });
  await pause(750);
  assert.equal(game.phase, 'question');
  assert.equal(game.submitAnswer('second', 1).accepted, true);
  await pause(750);
  assert.equal(game.phase, 'reveal');
});

test('invalid and late answers are rejected without changing the score', t => {
  const game = createGame(t);
  game.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'one' });
  game.nextStep();
  for (const index of [null, '', '  ', false, 1.5, 4]) {
    assert.equal(game.submitAnswer('player', index).accepted, false);
  }
  game.questionStartedAt -= game.questionTimeLimit * 1000;
  assert.equal(game.submitAnswer('player', 1).accepted, false);
  assert.equal(game.players.get('player').score, 0);
  assert.equal(game.phase, 'reveal');
});

test('question times up to 90 seconds survive import and gameplay', t => {
  const imported = FileImporter.normalizeQuestionObj({ ...question('one'), timeLimit: 90 }, 0);
  const rows = FileImporter.rowsToQuestions([{ vraag: 'Vraag?', tijdslimiet: 90 }]);
  assert.equal(imported.timeLimit, 90);
  assert.equal(rows[0].timeLimit, 90);
  const game = createGame(t, [imported]);
  game.nextStep();
  assert.equal(game.questionTimeLimit, 90);
});

test('empty JSON quizzes are rejected instead of saving an unplayable quiz', () => {
  for (const quiz of [[], { title: 'Leeg', questions: [] }]) {
    assert.throws(() => FileImporter.normalizeJsonQuiz(quiz), /Geen vragen gevonden/);
  }
});

test('only the first correct answer wins, once when the round closes', t => {
  const game = createGame(t);
  const winners = [];
  game.on('fastest_correct', event => winners.push(event));
  for (const id of ['wrong', 'fastest', 'later']) {
    game.joinOrReconnectPlayer({ playerId: id, name: id, socketId: id });
  }
  game.nextStep();
  game.submitAnswer('wrong', 0);
  game.submitAnswer('fastest', 1);
  game.submitAnswer('later', 1);
  assert.equal(winners.length, 0);
  game.nextStep();
  assert.equal(winners.length, 1);
  assert.equal(winners[0].playerId, 'fastest');
  assert.ok(winners[0].roundId);
  game._finalizeQuestionRound();
  assert.equal(winners.length, 1);

  game.nextStep();
  game.submitAnswer('wrong', 0);
  game.nextStep();
  assert.equal(winners.length, 1);

  game.nextStep();
  game.nextStep();
  game.nextStep();
  game.submitAnswer('later', 1);
  game.nextStep();
  assert.equal(winners.length, 2);
  assert.equal(winners[1].playerId, 'later');
  assert.notEqual(winners[1].roundId, winners[0].roundId);
});
