# frozen_string_literal: true

# ActionCable refuses an upgrade whose `Origin` header is empty, so a
# non-browser client — the e2e harness, a CLI, a bot — cannot open `/cable` at
# all. Browsers always send Origin, so this only widens the set of clients that
# can reach the cable; it does not weaken CSRF for a browser, which still has to
# pass the same origin check.
#
# Production keeps the strict default unless ALLOWED_CABLE_ORIGINS is set, so a
# deployment opts in explicitly rather than inheriting a permissive list.
if (allowed = ENV["ALLOWED_CABLE_ORIGINS"])
  origins = allowed.split(",").map(&:strip).reject(&:empty?)
  Rails.application.config.action_cable.allowed_request_origins =
    origins + [/https?:\/\/.*\.localhost(:\d+)?/, %r{https?://(127\.0\.0\.1|localhost)(:\d+)?}]
end
