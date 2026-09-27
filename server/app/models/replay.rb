# frozen_string_literal: true

class Replay < ApplicationRecord
  FORMAT_STARC = 1
  FORMAT_NAME = "starc-replay"

  belongs_to :match

  enum :format, { starc: 1 }, validate: true

  validates :version, presence: true, numericality: { only_integer: true, greater_than: 0 }
  validates :header, :commands, :final_state, presence: true
  validates :command_count, :tick_count, presence: true,
                           numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :match_id, uniqueness: true

  scope :recent_first, -> { order(created_at: :desc) }

  def self.record!(match:, commands:, final_state:, tick_count:, header: nil, command_count: nil)
    create!(
      match: match,
      version: 1,
      format: :starc,
      header: JSON.generate(header || match.replay_header),
      commands: JSON.generate(commands || []),
      final_state: JSON.generate(final_state || {}),
      command_count: command_count || Array(commands).size,
      tick_count: tick_count.to_i
    )
  end

  def parsed_header
    JSON.parse(header)
  end

  def parsed_commands
    JSON.parse(commands)
  end

  def parsed_final_state
    JSON.parse(final_state)
  end

  def to_replay_hash
    {
      format: FORMAT_NAME,
      version: version,
      header: parsed_header,
      commands: parsed_commands,
      final_state: parsed_final_state
    }
  end

  # Shape returned by `GET /api/v1/matches/:id/replay` (PROTOCOL §7).
  def to_download_hash
    {
      header: parsed_header,
      commands: parsed_commands,
      snapshots_meta: {
        tick_count: tick_count,
        command_count: command_count,
        version: version
      },
      replay_url: "/api/v1/matches/#{match_id}/replay"
    }
  end
end
