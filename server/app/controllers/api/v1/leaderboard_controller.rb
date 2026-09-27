# frozen_string_literal: true

module Api
  module V1
    class LeaderboardController < BaseController
      DEFAULT_LIMIT = 50
      MAX_LIMIT = 200

      # GET /api/v1/leaderboard
      def index
        limit = coerce_int(:limit, min: 1, max: MAX_LIMIT, default: DEFAULT_LIMIT) || DEFAULT_LIMIT
        mode = coerce_str(:mode, max_length: 32)
        race = coerce_str(:race, max_length: 32)

        scope = LeaderboardEntry.all
        scope = scope.where(mode: mode) if mode.present? && MATCH_MODES.include?(mode)
        scope = scope.where(race: race) if race.present? && RACE_KEYS.include?(race)

        rows = scope.includes(:player).order(rating: :desc, wins: :desc, id: :asc).limit(limit).to_a

        render_ok(entries: rows.each_with_index.map { |entry, index| entry_json(entry, index + 1) })
      end

      private

      def entry_json(entry, position)
        {
          rank: entry.rank.to_i.positive? ? entry.rank.to_i : position,
          player_id: entry.player_id,
          name: entry.player&.name.to_s,
          race: entry.race,
          mode: entry.mode.to_s,
          wins: entry.wins.to_i,
          losses: entry.losses.to_i,
          draws: entry.draws.to_i,
          rating: entry.rating.to_i
        }
      end
    end
  end
end
