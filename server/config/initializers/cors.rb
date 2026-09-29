# Be sure to restart your server when you modify this file.

# The Vite dev server proxies /cable, but the REST API is called
# cross-origin, so the browser needs CORS on the API and on the ActionCable
# endpoint (the client may reach it directly when the proxy is bypassed).
#
# The two dev origins are all that exists by default, so a deployment that
# serves the client from a *different* origin than the API has no way in:
# every cross-origin call fails at the preflight. `CORS_ORIGINS` is the
# escape hatch — a comma-separated list of additional allowed origins, with
# blank segments dropped and surrounding whitespace trimmed, so
# `CORS_ORIGINS="https://starc.example, https://admin.starc.example"` works
# and a stray trailing comma is not a silently-allowed empty origin. An unset
# or empty variable leaves the list exactly as it was in development.
#
# A same-origin production deployment does not need this at all: the browser
# sends no cross-origin request, so CORS never runs. Set it only for a split
# deployment (client CDN, staging client against production API) — and note
# that the cable has its own, separate allowlist in cable.rb.
#
# Read more: https://github.com/cyu/rack-cors

Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    # Computed inline (not as a constant) so a code reload does not warn about
    # re-defining it.
    origins(*(["http://localhost:5173", "http://127.0.0.1:5173"] +
      ENV["CORS_ORIGINS"].to_s.split(",").map(&:strip).reject(&:empty?)).uniq)

    resource "*",
      headers: %w[Authorization Content-Type],
      methods: %i[get post delete options],
      max_age: 3600
  end
end

# The client always connects to /cable (PROTOCOL.md §1). This is already the
# Rails default, but pinning it here keeps the mount point in one place next to
# the CORS rules that have to match it.
Rails.application.config.action_cable.mount_path = "/cable"
