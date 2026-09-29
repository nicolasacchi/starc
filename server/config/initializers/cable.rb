# frozen_string_literal: true

# ActionCable's development default is `/https?:\/\/localhost:\d+/` (set in
# `actioncable/engine.rb`), which matches `http://localhost:5173` but not
# `http://127.0.0.1:5173` — and `vite.config.ts` binds 127.0.0.1, so opening the
# client by IP rather than by hostname is a completely normal thing to do and
# got a 1002 on `/cable` with the game never connecting. It also refuses an
# upgrade with an *empty* Origin, so a non-browser client — the e2e harness, a
# CLI, a bot — cannot open the cable at all.
#
# PRODUCTION MUST SET `ALLOWED_CABLE_ORIGINS` to the public origin the client is
# served from (e.g. `https://starc.scc.im`). Nothing here learns a deployment's
# own origin: the loopback list below is a development convenience and matches
# nothing real, so an unset variable in production means every browser cable
# upgrade is refused with 1002 and the game never connects at all — a total
# outage that looks like a client bug. A non-browser client (the e2e harness, a
# CLI) is refused an empty Origin unless an entry here matches it too, so the
# same variable is what lets those clients in.
#
# This is deliberately separate from `CORS_ORIGINS` in cors.rb: the browser
# sends `Origin` on the REST fetch, but this check is the one that decides
# whether `/cable` is upgraded at all, and only ActionCable's allowlist can
# grant that.
#
# Origins are matched by `Regexp#===` against the raw header, so this must be
# an array of regexes. Note the trap: assigning `true` here does NOT mean
# "allow everything" — `Array(true).any? { |o| o === origin }` matches nothing,
# which silently disables every origin including the ones you meant to keep.
loopback = [%r{\Ahttps?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\z},
            %r{\Ahttps?://.*\.localhost(:\d+)?\z}]

configured = ENV["ALLOWED_CABLE_ORIGINS"].to_s.split(",").map(&:strip).reject(&:empty?)

cable = Rails.application.config.action_cable
existing = Array(cable.allowed_request_origins).grep_v(true) # a bare `true` is a
cable.allowed_request_origins =                        # trap, not a real entry
  (existing + loopback + configured).uniq
