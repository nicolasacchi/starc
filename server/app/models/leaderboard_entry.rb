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

  # The leaderboard is a projection of finished matches: it is written when a
  # result lands, not by whoever happens to score the match. Results reach the
  # database as a `MatchPlayer#result` write, and that write happens in
  # `Starc::MatchRunner#apply_results` — the one place results are persisted,
  # whether the match ended in the world, on a cable forfeit or over REST. The
  # runner is not this model's business, so the projection is attached to the
  # seat row below rather than repeated inside one of its callers, which is
  # exactly how it came to have no writer at all.
  #
  # Idempotent by construction: the hook only fires when a seat's result
  # actually changes, so re-applying the same result — the second forfeit
  # path, a second process adopting a match that is already over — moves the
  # entry once, not twice.
  def self.record_seat_result!(seat)
    result = seat.result.to_s
    return nil if result.blank? || result == "pending"

    match = seat.match
    return nil if match.nil? || match.abandoned?

    row = self.for(seat.player, mode: match.mode)
    row.save! if row.new_record?
    row.record!(result: result, opponent_rating: field_rating_for(match, seat.player_id), race: seat.race)
  end

  # The rating of everybody the player faced, averaged. An opponent with no
  # entry yet is rated at the default, so a first match moves the rating by
  # about half of K rather than a full K against an assumed 1200 opponent.
  def self.field_rating_for(match, player_id)
    opponents = match.match_players.where.not(player_id: player_id).pluck(:player_id)
    return DEFAULT_RATING if opponents.empty?

    ratings = where(player_id: opponents, mode: match.mode).pluck(:rating)
    return DEFAULT_RATING if ratings.empty?

    (ratings.sum.to_f / ratings.size).round
  end

  def self.record_results!(match)
    match.match_players.includes(:player).each { |seat| record_seat_result!(seat) }
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

# The one place a result is written is the seat row, so that is where the
# leaderboard is kept in step with it. The hook lives here rather than in
# `match_player.rb` because the leaderboard is the projection and the seat is
# the event: whoever changes the seat must not have to remember this.
MatchPlayer.after_update :record_leaderboard_result

class MatchPlayer
  private

  def record_leaderboard_result
    LeaderboardEntry.record_seat_result!(self) if saved_change_to_result?
  rescue StandardError => e
    # A ranking that fails to move must never take a match result down with
    # it; the entry is derived from the seat rows, so the next result re-derives
    # what was missed.
    Rails.logger.error("[starc] leaderboard update for seat #{id} failed: #{e.class}: #{e.message}")
  end
end
