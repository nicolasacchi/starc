Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      # Auth / identity
      post   "players",  to: "players#create"
      post   "session",  to: "sessions#create"
      delete "session",  to: "sessions#destroy"
      get    "me",       to: "sessions#show"
      get    "me/stats", to: "sessions#stats"

      # Static game data
      get "races", to: "game_data#races"
      get "maps",  to: "game_data#maps"

      # Matches / lobby
      resources :matches, only: %i[index show create] do
        member do
          post :join
          post :leave
          post :ready
          post :start
          post :forfeit
          get  :replay
          get  :replay_file
        end
      end

      # Leaderboard
      get "leaderboard", to: "leaderboard#index"

      # Player public profile + stats
      get "players/:name/stats", to: "players#stats", as: :player_stats
    end
  end

  # ActionCable is mounted by the framework; the dev server proxies /cable.
  get "up", to: proc { [200, { "Content-Type" => "application/json" }, ['{"status":"ok"}']] }

  # Client-side routes. The app is API-only, but the SPA it serves is a real
  # file (public/index.html), so any client-side path that is reloaded or
  # opened directly has to come back as that file instead of a routing error.
  #
  # The position is load-bearing. Rails matches in definition order, so this
  # above the `api` namespace would answer every /api/v1/* call with HTML and
  # a 200 — the client would parse garbage instead of seeing a failure. And
  # the constraint is not redundant with the ordering: an unknown /api/... path
  # matches no api route and falls through to the last one, which is why the
  # API's JSON 404 has to be pinned here rather than assumed. /up is matched
  # by the route above and /cable by the ActionCable mount, which its engine
  # prepends ahead of every user route; both are excluded as well so that no
  # future reordering can turn the health check or the cable into HTML.
  # An API surface must answer a JSON client in JSON. Without this, a path no
  # route matches (`/api/v1/nope`) never reaches a route at all, so Rails falls
  # back to PublicExceptions and returns an EMPTY body with Content-Type
  # text/html — a client that calls res.json() on it throws a parse error
  # instead of seeing a 404. Real endpoints already do the right thing via
  # their controllers (`/api/v1/matches/999999` returns JSON); this closes the
  # gap for paths that are not endpoints at all. The error envelope is the same
  # shape the controllers use (see ApplicationController's rescue handlers), so
  # one client error path handles both.
  match "*unmatched", to: "api/v1/errors#not_found", via: :all,
        constraints: ->(request) { request.path_info.match?(%r{\A/api(?:/|\z)}) }

  get "*path",
      to: ->(_env) {
        index = Rails.public_path.join("index.html")
        if index.file?
          headers = { "Content-Type" => "text/html; charset=utf-8", "Cache-Control" => "no-store" }
          [200, headers, [index.binread]]
        else
          # No client build in this image (a dev checkout, or a test run): keep
          # the 404 that path used to raise, instead of an empty body.
          [404, { "Content-Type" => "text/plain; charset=utf-8" }, ["Not Found"]]
        end
      },
      constraints: ->(request) { !request.path_info.match?(%r{\A/(?:api|up|cable)(?:/|\z)}) }
end
