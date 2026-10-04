-- Close an idle player after a confirmed playback error. Keep prelaunch,
-- normal EOF, and playlist transitions available to Streamee.
local mp = require('mp')
local failed = false

local function close_failed_idle_player()
    if failed and mp.get_property_native('idle-active', false) then
        failed = false
        mp.msg.warn('Closing MPV after failed playback returned to idle')
        mp.commandv('quit')
    end
end

mp.register_event('start-file', function()
    failed = false
end)

mp.register_event('end-file', function(event)
    failed = event.reason == 'error'
    if failed then
        mp.msg.warn('Playback failed: ' .. tostring(event.file_error or event.error or 'unknown error'))
        -- The idle property may already have changed before this callback.
        mp.add_timeout(0, close_failed_idle_player)
    end
end)

mp.observe_property('idle-active', 'bool', close_failed_idle_player)
