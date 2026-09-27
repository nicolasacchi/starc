# frozen_string_literal: true

require "securerandom"

class Player < ApplicationRecord
  SESSION_TTL = 30.days
  NAME_PATTERN = /\A[A-Za-z0-9_-]+\z/
  BASE_RATING = 1200

  has_secure_password

  has_many :sessions, dependent: :destroy
  has_many :match_players, dependent: :destroy
  has_many :matches, through: :match_players
  has_many :leaderboard_entries, dependent: :destroy

  before_validation :normalize_name

  validates :name, presence: true, length: { in: 3..24 }, format: { with: NAME_PATTERN },
                   uniqueness: { case_sensitive: false }
  validates :password, length: { minimum: 6 }, allow_nil: true
  validates :wins, :losses, :draws, :kills, :deaths, :units_built,
            numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :resources_mined, numericality: { only_integer: true, greater_than_or_equal_to: 0 }

  # Anonymous opponents score a neutral rating.
  def rating
    games = wins.to_i + losses.to_i
    return BASE_RATING if games.zero?

    (BASE_RATING + ((wins.to_i - losses.to_i) * 400.0 / games)).round
  end

  def matches_played
    wins.to_i + losses.to_i + draws.to_i
  end

  def to_public_hash
    {
      id: id,
      name: name,
      rating: rating,
      wins: wins,
      losses: losses,
      draws: draws,
      kills: kills,
      deaths: deaths,
      resources_mined: resources_mined.to_i,
      units_built: units_built,
      last_race: last_race
    }
  end

  def stats_hash
    {
      rating: rating,
      wins: wins,
      losses: losses,
      draws: draws,
      matches_played: matches_played,
      kills: kills,
      deaths: deaths,
      resources_mined: resources_mined.to_i,
      units_built: units_built,
      kd: deaths.to_i.zero? ? kills.to_f : (kills.to_f / deaths).round(2),
      last_race: last_race
    }
  end

  def active_session?(now = Time.current)
    sessions.live.where("expires_at > ?", now).exists?
  end

  # The `sessions` table is the single source of truth for auth tokens —
  # multiple concurrent devices, expiry and revocation all live there.
  def issue_session!(ip: nil)
    sessions.create!(token: SecureRandom.urlsafe_base64(32), expires_at: SESSION_TTL.from_now, last_ip: ip)
  end

  def expire_sessions!
    sessions.where(expires_at: ..Time.current).delete_all
    self
  end

  # The increment is read inside the lock, never before it: `with_lock`
  # reloads the row under the lock, so two results landing at once each see
  # the other's write and both are counted. Computed before, both would write
  # the same number and one match would vanish from the career record.
  def record_result!(result:, kills: 0, deaths: 0, resources_mined: 0, units_built: 0)
    outcome = case result.to_s
              when "win", "loss", "draw" then result.to_s
              else raise ArgumentError, "unknown result #{result.inspect}"
              end

    with_lock do
      case outcome
      when "win" then self.wins += 1
      when "loss" then self.losses += 1
      when "draw" then self.draws += 1
      end
      update!(kills: kills.to_i, deaths: deaths.to_i,
              resources_mined: resources_mined.to_i, units_built: units_built.to_i)
    end
    self
  end

  private

  def normalize_name
    self.name = name.strip if name.is_a?(String)
  end
end
