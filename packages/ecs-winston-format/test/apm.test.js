// Licensed to Elasticsearch B.V. under one or more contributor
// license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright
// ownership. Elasticsearch B.V. licenses this file to you under
// the Apache License, Version 2.0 (the "License"); you may
// not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

'use strict'

// Test integration with Elastic APM.

const http = require('http')
const path = require('path')
const { execFile, spawn } = require('child_process')
const zlib = require('zlib')

const addFormats = require('ajv-formats').default
const Ajv = require('ajv').default
const split = require('split2')
const test = require('tap').test

const { ecsLoggingValidate } = require('../../../utils/lib/ecs-logging-validate')

const ajv = new Ajv({
  allErrors: true,
  verbose: true
})
addFormats(ajv)
const validate = ajv.compile(require('../../../utils/schema.json'))

test('tracing integration works', t => {
  let apmServer
  let app
  let appIsClosed = false
  const traceObjs = []
  const logObjs = []
  let stderr = ''

  // 1. Setup a mock APM server to accept trace data. Callback when listening.
  //    Pass intake data to `collectTracesLogsAndCheck()`.
  function step1StartMockApmServer (cb) {
    apmServer = http.createServer(function apmServerReq (req, res) {
      t.equal(req.method, 'POST')
      t.equal(req.url, '/intake/v2/events')
      let instream = req
      if (req.headers['content-encoding'] === 'gzip') {
        instream = req.pipe(zlib.createGunzip())
      } else {
        instream.setEncoding('utf8')
      }
      instream.pipe(split(JSON.parse)).on('data', function (traceObj) {
        collectTracesLogsAndCheck(traceObj, null)
      })
      req.on('end', function () {
        res.end('ok')
      })
    })
    apmServer.listen(0, function () {
      cb(null, 'http://localhost:' + apmServer.address().port)
    })
  }

  // 2. Start a test app that uses APM and our mock APM Server.
  //    Callback on first log line, which includes the app's HTTP address.
  //    Pass parsed JSON log records to `collectTracesLogsAndCheck()`.
  function step2StartApp (apmServerUrl, cb) {
    app = spawn(
      process.execPath,
      [
        path.join(__dirname, 'serve-one-http-req-with-apm.js'),
        apmServerUrl
      ],
      {
        env: Object.assign({}, process.env, {
          ELASTIC_APM_SERVICE_NODE_NAME: 'serviceNodeNameFromEnv'
        })
      }
    )
    let handledFirstLogLine = false
    app.stdout.pipe(split(JSON.parse)).on('data', function (logObj) {
      if (!handledFirstLogLine) {
        handledFirstLogLine = true
        t.equal(logObj.message, 'listening')
        t.ok(logObj.address, 'first listening log line has "address"')
        cb(null, logObj.address)
      } else {
        collectTracesLogsAndCheck(null, logObj)
      }
    })
    app.stderr.on('data', function (chunk) {
      stderr += chunk
    })
    app.on('close', function (code) {
      t.equal(stderr, '', 'empty stderr from app')
      t.equal(code, 0, 'app exited 0')
      appIsClosed = true
    })
  }

  // 3. Call the test app to generate a trace.
  function step3CallApp (appUrl, cb) {
    const req = http.request(appUrl + '/', function (res) {
      res.on('data', function () {})
      res.on('end', cb)
    })
    req.on('error', cb)
    req.end()
  }

  // 4. Collect trace data from the APM Server, log data from the app, and when
  // all the expected data is collected, then test it: assert matching tracing
  // IDs.
  function collectTracesLogsAndCheck (traceObj, logObj) {
    if (traceObj) {
      traceObjs.push(traceObj)
      t.comment(`received traceObjs ${traceObjs.length}`)
    }
    if (logObj) {
      t.ok(validate(logObj), 'logObj is ECS valid')
      t.equal(ecsLoggingValidate(logObj), null, 'logObj is ecs-logging valid')
      logObjs.push(logObj)
      t.comment(`received logObjs ${logObjs.length}`)
    }
    if (traceObjs.length >= 3 && logObjs.length >= 1) {
      t.ok(traceObjs[0].metadata, 'traceObjs[0] is metadata')
      const trans = traceObjs[1].transaction || traceObjs[2].transaction
      const span = traceObjs[1].span || traceObjs[2].span
      t.ok(trans, 'got transaction')
      t.ok(span, 'got span')
      t.equal(logObjs[0]['trace.id'], span.trace_id, 'trace.id matches')
      t.equal(logObjs[0]['transaction.id'], span.transaction_id, 'transaction.id matches')
      t.equal(logObjs[0]['span.id'], span.id, 'span.id matches')
      t.equal(logObjs[0]['service.name'], 'test-apm', 'service.name')
      t.equal(logObjs[0]['service.version'], 'override-serviceVersion', 'service.version')
      t.equal(logObjs[0]['service.environment'], 'development', 'service.environment')
      t.equal(logObjs[0]['service.node.name'], 'serviceNodeNameFromEnv', 'service.node.name')
      t.equal(logObjs[0]['event.dataset'], 'test-apm', 'event.dataset')
      finish()
    }
  }

  function finish () {
    if (appIsClosed) {
      apmServer.close(function () {
        t.end()
      })
    } else {
      app.on('close', function () {
        apmServer.close(function () {
          t.end()
        })
      })
    }
  }

  step1StartMockApmServer(function onListening (apmServerErr, apmServerUrl) {
    t.error(apmServerErr, 'no error from starting the mock APM server')
    if (apmServerErr) {
      finish()
      return
    }
    t.ok(apmServerUrl, 'apmServerUrl: ' + apmServerUrl)

    step2StartApp(apmServerUrl, function onReady (appErr, appUrl) {
      t.error(appErr, 'no error from starting the app')
      if (appErr) {
        finish()
        return
      }
      t.ok(appUrl, 'appUrl: ' + appUrl)

      step3CallApp(appUrl, function (clientErr) {
        t.error(clientErr, 'no error from calling the app')

        // The thread of control now is expected to be in
        // `collectTracesLogsAndCheck()`.
      })
    })
  })
})

// This is the same as the previous test, but sets `apmIntegration=false`
// and asserts tracing fields are *not* added to log records.
test('apmIntegration=false disables tracing integration', t => {
  let apmServer
  let app
  let appIsClosed = false
  const traceObjs = []
  const logObjs = []
  let stderr = ''

  // 1. Setup a mock APM server to accept trace data. Callback when listening.
  //    Pass intake data to `collectTracesLogsAndCheck()`.
  function step1StartMockApmServer (cb) {
    apmServer = http.createServer(function apmServerReq (req, res) {
      t.equal(req.method, 'POST')
      t.equal(req.url, '/intake/v2/events')
      let instream = req
      if (req.headers['content-encoding'] === 'gzip') {
        instream = req.pipe(zlib.createGunzip())
      } else {
        instream.setEncoding('utf8')
      }
      instream.pipe(split(JSON.parse)).on('data', function (traceObj) {
        collectTracesLogsAndCheck(traceObj, null)
      })
      req.on('end', function () {
        res.end('ok')
      })
    })
    apmServer.listen(0, function () {
      cb(null, 'http://localhost:' + apmServer.address().port)
    })
  }

  // 2. Start a test app that uses APM and our mock APM Server.
  //    Callback on first log line, which includes the app's HTTP address.
  //    Pass parsed JSON log records to `collectTracesLogsAndCheck()`.
  function step2StartApp (apmServerUrl, cb) {
    app = spawn(
      process.execPath,
      [
        path.join(__dirname, 'serve-one-http-req-with-apm.js'),
        apmServerUrl,
        'true' // disableApmIntegration argument
      ]
    )
    let handledFirstLogLine = false
    app.stdout.pipe(split(JSON.parse)).on('data', function (logObj) {
      if (!handledFirstLogLine) {
        handledFirstLogLine = true
        t.equal(logObj.message, 'listening')
        t.ok(logObj.address, 'first listening log line has "address"')
        cb(null, logObj.address)
      } else {
        collectTracesLogsAndCheck(null, logObj)
      }
    })
    app.stderr.on('data', function (chunk) {
      stderr += chunk
    })
    app.on('close', function (code) {
      t.equal(stderr, '', 'empty stderr from app')
      t.equal(code, 0, 'app exited 0')
      appIsClosed = true
    })
  }

  // 3. Call the test app to generate a trace.
  function step3CallApp (appUrl, cb) {
    const req = http.request(appUrl + '/', function (res) {
      res.on('data', function () {})
      res.on('end', cb)
    })
    req.on('error', cb)
    req.end()
  }

  // 4. Collect trace data from the APM Server, log data from the app, and when
  // all the expected data is collected, then test it: assert matching tracing
  // IDs.
  function collectTracesLogsAndCheck (traceObj, logObj) {
    if (traceObj) {
      traceObjs.push(traceObj)
      t.comment(`received traceObjs ${traceObjs.length}`)
    }
    if (logObj) {
      t.ok(validate(logObj), 'logObj is ECS valid')
      t.equal(ecsLoggingValidate(logObj), null, 'logObj is ecs-logging valid')
      logObjs.push(logObj)
      t.comment(`received logObjs ${logObjs.length}`)
    }
    if (traceObjs.length >= 3 && logObjs.length >= 1) {
      t.ok(traceObjs[0].metadata, 'traceObjs[0] is metadata')
      const trans = traceObjs[1].transaction || traceObjs[2].transaction
      const span = traceObjs[1].span || traceObjs[2].span
      t.ok(trans, 'got transaction')
      t.ok(span, 'got span')
      t.notOk(logObjs[0].trace, 'log record does *not* have "trace" object')
      t.notOk(logObjs[0].transaction, 'log record does *not* have "transaction" object')
      t.notOk(logObjs[0].span, 'log record does *not* have "span" object')
      t.notOk(logObjs[0].service, 'log record does *not* have "service" object')
      t.notOk(logObjs[0].event, 'log record does *not* have "event" object')
      finish()
    }
  }

  function finish () {
    if (appIsClosed) {
      apmServer.close(function () {
        t.end()
      })
    } else {
      app.on('close', function () {
        apmServer.close(function () {
          t.end()
        })
      })
    }
  }

  step1StartMockApmServer(function onListening (apmServerErr, apmServerUrl) {
    t.error(apmServerErr, 'no error from starting the mock APM server')
    if (apmServerErr) {
      finish()
      return
    }
    t.ok(apmServerUrl, 'apmServerUrl: ' + apmServerUrl)

    step2StartApp(apmServerUrl, function onReady (appErr, appUrl) {
      t.error(appErr, 'no error from starting the app')
      if (appErr) {
        finish()
        return
      }
      t.ok(appUrl, 'appUrl: ' + appUrl)

      step3CallApp(appUrl, function (clientErr) {
        t.error(clientErr, 'no error from calling the app')

        // The thread of control now is expected to be in
        // `collectTracesLogsAndCheck()`.
      })
    })
  })
})

test('invalid APM serviceName does not set service.name or event.dataset', t => {
  execFile(
    process.execPath,
    ['simple-log-hi.js'],
    {
      cwd: __dirname,
      env: Object.assign(
        {},
        process.env,
        {
          NODE_OPTIONS: '--require elastic-apm-node/start.js',
          ELASTIC_APM_LOG_LEVEL: 'off',
          ELASTIC_APM_SERVICE_NAME: 'foo☃bar'
        }
      ),
      timeout: 5000
    },
    function (err, stdout, _stderr) {
      t.error(err)
      const recs = stdout.trim().split(/\n/g).map(JSON.parse)
      t.equal(recs[0].message, 'hi')
      t.equal(recs[0]['service.name'], undefined)
      t.equal(recs[0]['event.dataset'], undefined)
      t.end()
    }
  )
})
