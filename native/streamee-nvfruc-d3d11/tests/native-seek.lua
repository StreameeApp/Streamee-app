local targets = {1.5, 0.25, 2.5}
local index = 0
local pending = false

local function seek_next()
    index = index + 1
    if index > #targets then
        mp.msg.info('LIFECYCLE_PROBE_DONE seeks=3 pause=1 resume=1')
        return
    end
    pending = true
    mp.commandv('seek', tostring(targets[index]), 'absolute+exact')
end

mp.register_event('playback-restart', function()
    if not pending then return end
    pending = false
    mp.add_timeout(0.4, function()
        local stats = mp.get_property_native('vf-metadata/streamee-optiflow', {})
        local time = mp.get_property_number('time-pos', -1)
        if stats.state ~= 'active' or (tonumber(stats.synthesized) or 0) <= 0
            or time < targets[index] - 0.05 then
            mp.msg.error('LIFECYCLE_PROBE_FAILED: synthesis did not resume after seek')
            return
        end
        mp.msg.info('LIFECYCLE_SEEK_OK ' .. tostring(index))
        seek_next()
    end)
end)

mp.register_event('file-loaded', function()
    mp.add_timeout(0.35, function()
        mp.set_property_native('pause', true)
        -- Let any frame already being presented settle before measuring the hold.
        mp.add_timeout(0.15, function()
            local paused_time = mp.get_property_number('time-pos', -1)
            mp.add_timeout(0.25, function()
                if not mp.get_property_native('pause') or paused_time < 0
                    or mp.get_property_number('time-pos', -2) ~= paused_time then
                    mp.msg.error('LIFECYCLE_PROBE_FAILED: paused timestamp advanced')
                    return
                end
                mp.set_property_native('pause', false)
                mp.add_timeout(0.25, seek_next)
            end)
        end)
    end)
end)
