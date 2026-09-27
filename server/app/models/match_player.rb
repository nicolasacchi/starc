# frozen_string_literal: true

class MatchPlayer < ApplicationRecord
  RACES = %w[terran zerg protoss].freeze

  belongs_to :match
  belongs_to :player

  enum :result, { pending: 0, win: 1, loss: 2, draw: 3 }, validate: true

  validates :slot, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 },
                   uniqueness: { scope: :match_id, message: "already taken in this match" }
  validates :team, presence: true, numericality: { only_integer: true, greater_than: 0 }
  validates :race, presence: true, inclusion: { in: RACES, message: "%{value} is not a playable race" }
  validates :player_id, uniqueness: { scope: :match_id, message: "is already in this match" }
  validates :kills, :deaths, :units_built, :army_value,
            numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :resources_mined, numericality: { only_integer: true, greater_than_or_equal_to: 0 }

  scope :ordered, -> { order(:slot) }

  # The seats of one player whose match is still live (a lobby waiting to start
  # or a running game). `finished` and `abandoned` matches do not count: they
  # must not keep a player from joining something else. The single definition
  # both join paths consult, so REST and cable cannot disagree about whether a
  # second seat is possible.
  def self.live_seats_for(player_id)
    live = Match.where(status: [Match.statuses.fetch("lobby"), Match.statuses.fetch("in_progress")])
    joins(:match).where(player_id: player_id).merge(live)
  end

  def self.race_taken?(match, race)
    return false if race.blank?

    match.match_players.where(race: race.to_s).exists?
  end

  def next_free_race(excluded = nil)
    RACES.find { |r| r != excluded.to_s && !self.class.race_taken?(match, r) } || RACES.first
  end

  def to_lobby_hash
    {
      player_id: player_id,
      name: player&.name.to_s,
      race: race,
      ready: ready,
      is_host: host,
      slot: slot,
      team: team
    }
  end

  def to_score_hash
    {
      player_id: player_id,
      race: race,
      result: pending? ? "draw" : result,
      kills: kills,
      deaths: deaths,
      resources_mined: resources_mined.to_i,
      units_built: units_built,
      army_value: army_value
    }
  end
end
