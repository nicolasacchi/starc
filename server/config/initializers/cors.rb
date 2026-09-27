# Be sure to restart your server when you modify this file.

# The Vite dev server proxies /cable, but the REST API is called
# cross-origin, so the browser needs CORS on the API and on the ActionCable
# endpoint (the client may reach it directly when the proxy is bypassed).
#
# Read more: https://github.com/cyu/rack-cors

Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins "http://localhost:5173", "http://127.0.0.1:5173"

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
