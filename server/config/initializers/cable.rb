# frozen_string_literal: true

# ActionCable refuses an upgrade whose `Origin` is not in
# `allowed_request_origins`, and refuses one that is *empty* outright — so a
# non-browser client (the e2e harness, a CLI, a bot) cannot open `/cable` at
# all, and neither can a developer who opens the Vite dev server by IP rather
# than by hostname. `vite.config.ts` binds `127.0.0.1`, so `http://127.0.0.1:5173`
# is a completely normal way to load the client.
#
# Loopback origins are therefore allowed unconditionally: they cannot be
# reached from another machine, so permitting them does not weaken CSRF for a
# real deployment. Everything else stays opt-in via ALLOWED_CABLE_ORIGINS, and
# production still gets the strict default unless a deployment sets it.
loopback = [%r{\Ahttps?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\z},
            %r{\Ahttps?://.*\.localhost(:\d+)?\z}]

configured = ENV["ALLOWED_CABLE_ORIGINS"].to_s.split(",").map(&:strip).reject(&:empty?)

Rails.application.config.action_cable.allowed_request_origins =
  Rails.application.config.action_cable.allowed_request_origins | loopback | configured
