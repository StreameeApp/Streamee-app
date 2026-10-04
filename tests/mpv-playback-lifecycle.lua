local host = require('mp')
local script = assert(os.getenv('STREAMEE_PLAYBACK_LIFECYCLE_SCRIPT'))

local function session()
    local events, timers, observer = {}, {}, nil
    local idle, quits = true, 0
    local fake = {
        msg = {warn = function() end},
        register_event = function(name, callback) events[name] = callback end,
        observe_property = function(_, _, callback) observer = callback end,
        get_property_native = function() return idle end,
        add_timeout = function(_, callback) timers[#timers + 1] = callback end,
        commandv = function(command) assert(command == 'quit'); quits = quits + 1 end,
    }
    package.loaded.mp = fake
    dofile(script)
    package.loaded.mp = host
    return {
        event = function(name, value) events[name](value) end,
        idle = function(value) idle = value; observer() end,
        flush = function() for _, callback in ipairs(timers) do callback() end; timers = {} end,
        quits = function() return quits end,
    }
end

local function tests()
    local s = session()
    s.idle(true)
    assert(s.quits() == 0, 'prelaunch idle must stay open')
    for _, reason in ipairs({'eof', 'stop', 'quit', 'redirect', 'unknown'}) do
        s.event('end-file', {reason = reason})
        s.idle(true)
        s.flush()
        assert(s.quits() == 0, 'non-error end must stay open: ' .. reason)
    end

    s = session()
    s.event('end-file', {reason = 'error', file_error = 'loading failed'})
    s.flush()
    s.idle(true)
    assert(s.quits() == 1, 'already idle failure must close exactly once')

    s = session()
    s.idle(false)
    s.event('end-file', {reason = 'error'})
    s.flush()
    assert(s.quits() == 0, 'must wait for idle after error')
    s.idle(true)
    assert(s.quits() == 1, 'later idle must close failed player')

    s = session()
    s.idle(false)
    s.event('end-file', {reason = 'error'})
    s.event('start-file', {})
    s.flush()
    s.event('end-file', {reason = 'eof'})
    s.idle(true)
    assert(s.quits() == 0, 'next playlist item must clear the previous error')
end

local ok, message = pcall(tests)
package.loaded.mp = host
if ok then host.msg.info('Playback lifecycle tests passed') else host.msg.error(message) end
host.commandv('quit', ok and 0 or 1)
