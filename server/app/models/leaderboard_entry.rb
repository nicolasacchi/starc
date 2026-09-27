# frozen_string_literal: true

class LeaderboardEntry < ApplicationRecord
  K_FACTOR = 32
  DEFAULT_RATING = 1200

  belongs_to :player

  validates :mode, presence: true, inclusion: { in: Match::MODES }
  validates :wins, :losses, :draws, presence: true,
                    numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :rating, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :rank, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :player_id, uniqueness: { scope: :mode, message: "already has an entry for this mode" }
  validates :race, inclusion: { in: MatchPlayer::RACES }, allow_blank: true

  scope :by_rank, -> { order(rank: :asc, rating: :desc, id: :asc) }

  def self.for(player, mode: "melee", race: nil)
    find_or_initialize_by(player_id: player.is_a?(Player) ? player.id : player, mode: mode.to_s).tap do |e|
      e.race = race.to_s if race.present? && e.race.blank?
    end
  end

  # Recomputes 1-based dense ranks for this entry's mode.
  def recompute_rank!
    rows = self.class.where(mode: mode).order(rating: :desc, wins: :desc, id: :asc).pluck(:id)
    rows.each_with_index { |entry_id, index| self.class.where(id: entry_id).update_all(rank: index + 1) }
    reload
  end

  def self.recompute_ranks!(mode: nil)
    scope = mode ? where(mode: mode.to_s) : all
    scope.distinct.pluck(:mode).each { |m| where(mode: m).order(:id).first&.recompute_rank! }
  end

  def games
    wins.to_i + losses.to_i + draws.to_i
  end

  def expected_score(opponent_rating)
    1.0 / (1.0 + (10.0**(((opponent_rating || DEFAULT_RATING) - rating) / 400.0)))
  end

  def record!(result:, opponent_rating: DEFAULT_RATING, race: nil)
    with_lock do
      self.race = race.to_s if race.present?
      expected = expected_score(opponent_rating)
      actual = case result.to_s
               when "win" then 1.0
               when "loss" then 0.0
               when "draw" then 0.5
               else raise ArgumentError, "unknown result #{result.inspect}"
               end
      delta = (K_FACTOR * (actual - expected)).round

      case result.to_s
      when "win" then self.wins += 1
      when "loss" then self.losses += 1
      when "draw" then self.draws += 1
      end
      self.rating = [[rating.to_i + delta, 0].max, 4000].min
      save!
    end
    recompute_rank!
    self
  end
end
