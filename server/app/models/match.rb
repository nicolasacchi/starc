# frozen_string_literal: true

class Match < ApplicationRecord
  MODES = %w[melee custom 1v1 team].freeze

  has_many :match_players, dependent: :destroy
  has_many :players, through: :match_players
  has_one  :replay, dependent: :destroy

  enum :status, { lobby: 0, in_progress: 1, finished: 2, abandoned: 3 }, validate: true

  validates :name, presence: true, length: { maximum: 64 }
  validates :mode, presence: true, inclusion: { in: MODES }
  validates :map_id, presence: true
  validates :max_players, presence: true,
                          numericality: { only_integer: true, in: 2..8 }
  validates :seed, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :winner_player_id, numericality: { only_integer: true }, allow_nil: true
  validates :duration_ms, numericality: { only_integer: true, greater_than_or_equal_to: 0 }, allow_nil: true
  validates :ended_at, presence: true, if: -> { finished? || abandoned? }
  validate  :map_id_must_exist

  scope :recent_first, -> { order(created_at: :desc) }
  scope :joinable, -> { where(status: statuses[:lobby]) }

  def players_ordered
    match_players.includes(:player).ordered.to_a
  end

  def host_player
    players_ordered.find(&:host?)&.player
  end

  def host_match_player
    players_ordered.find(&:host?)
  end

  # `count` issues a COUNT query; `size` would read the cached association and
  # go stale the moment a player leaves.
  def player_count
    match_players.count
  end

  def full?
    player_count >= max_players.to_i
  end

  def joinable?
    lobby? && !full?
  end

  def add_player!(player:, race: nil, host: nil, ready: false, team: nil)
    raise ArgumentError, "match is full" if full?
    raise ArgumentError, "player is already in this match" if match_players.exists?(player_id: player.id)

    taken = match_players.pluck(:race)
    chosen = (race.presence || MatchPlayer::RACES.find { |r| !taken.include?(r) } || MatchPlayer::RACES.first).to_s
    mp = match_players.create!(
      player: player,
      race: chosen,
      slot: next_free_slot,
      team: team || default_team,
      # The first player to arrive hosts the match; `remove_player!` hands the
      # role to the lowest remaining slot.
      host: host.nil? ? match_players.empty? : host,
      ready: ready
    )
    update_host_flags if mp.host?
    mp
  end

  def remove_player!(player)
    mp = match_players.find_by(player_id: player.is_a?(Player) ? player.id : player)
    return nil if mp.nil?

    was_host = mp.host?
    mp.destroy!
    remaining = players_ordered
    if was_host && remaining.any?
      remaining.first.update!(host: true)
    end
    mp
  end

  def all_ready?
    list = players_ordered
    list.size >= 2 && list.all?(&:ready?)
  end

  def team_count
    match_players.distinct.count(:team)
  end

  def startable?
    lobby? && all_ready? && players_ordered.size >= 2
  end

  def start!(started_at: Time.current)
    raise ArgumentError, "not startable" unless startable?

    update!(status: :in_progress, started_at: started_at)
  end

  def finish!(winner_player_id:, reason:, duration_ms: nil, ended_at: Time.current)
    update!(
      status: :finished,
      winner_player_id: winner_player_id,
      end_reason: reason,
      duration_ms: duration_ms || ((ended_at - (started_at || ended_at)) * 1000).to_i,
      ended_at: ended_at
    )
  end

  # A match password is a shared secret, not a player's: the lobby channel sets
  # `password_digest` directly and checks it here.
  def authenticate(raw)
    return false if password_digest.blank?

    BCrypt::Password.new(password_digest) == raw
  end

  def to_summary_hash
    {
      id: id,
      name: name,
      mode: mode,
      map_id: map_id,
      max_players: max_players,
      player_count: player_count,
      status: status,
      has_password: password_digest.present?,
      host: host_player&.name.to_s
    }
  end

  def to_detail_hash
    to_summary_hash.merge(players: players_ordered.map(&:to_lobby_hash))
  end

  def replay_header
    {
      match_id: id,
      map_id: map_id,
      seed: seed,
      mode: mode,
      started_at: started_at&.utc&.iso8601,
      duration_ms: duration_ms || 0,
      winner: winner_player_id,
      players: players_ordered.map do |mp|
        {
          player_id: mp.player_id,
          name: mp.player&.name.to_s,
          race: mp.race,
          team: mp.team,
          result: mp.pending? ? "draw" : mp.result
        }
      end
    }
  end

  private

  # Melee puts everyone on their own team; team modes alternate so allies
  # share a team number and the sim can treat them as allied.
  def default_team
    return 1 if mode.to_s == "melee"

    (match_players.count % 2) + 1
  end

  def next_free_slot
    used = match_players.pluck(:slot)
    (0...max_players.to_i).find { |s| !used.include?(s) } || used.max.to_i + 1
  end

  def update_host_flags
    match_players.where.not(host: true).update_all(host: false, updated_at: Time.current)
  end

  def map_id_must_exist
    return if map_id.blank?
    return if Starc::Maps.exist?(map_id)

    errors.add(:map_id, "is not a known map")
  end
end
