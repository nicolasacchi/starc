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
end
