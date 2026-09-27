# frozen_string_literal: true

module Starc
  module Sim
    # Outcome of one `game:command` batch: how many commands took effect and
    # the ones that were dropped, matched back to their index in the batch
    # (PROTOCOL.md §4, `game:reject`).
    #
    # Every command in a batch is validated independently and rejected
    # individually — one bad entity id never takes the rest of the batch with
    # it, which is why this collects a list rather than raising.
    class CommandResult
      # The fixed rejection vocabulary from PROTOCOL.md §4. Nothing outside
      # this list may ever reach the wire.
      CODES = %w[
        not_owner no_such_entity dead_entity invalid_target out_of_range
        insufficient_resources queue_full production_busy cooldown not_ready
        invalid_payload no_such_unit_type no_such_ability
      ].freeze

      Rejection = Struct.new(:index, :code, :message) do
        def to_h
          { index: index, code: code, message: message }
        end

        def to_json_hash
          { "index" => index, "code" => code, "message" => message }
        end
      end

      attr_reader :applied, :rejected

      def initialize(applied = 0, rejected = [])
        @applied = applied
        @rejected = rejected
      end

      def self.ok(count = 1)
        new(count, [])
      end

      def self.failed(index, code, message)
        new(0, [Rejection.new(index, code, message)])
      end

      def accept!
        @applied += 1
        self
      end

      # Codes outside CODES are a programming error, not a runtime condition.
      def reject!(index, code, message)
        raise ArgumentError, "unknown rejection code #{code.inspect}" unless CODES.include?(code)

        @rejected << Rejection.new(index, code, message)
        self
      end

      def merge!(other)
        @applied += other.applied
        @rejected.concat(other.rejected)
        self
      end

      def applied?
        @applied.positive?
      end

      def rejected?
        !@rejected.empty?
      end

      def total
        @applied + @rejected.size
      end

      def [](key)
        to_h[key]
      end

      def to_h
        { applied: @applied, rejected: @rejected.map(&:to_h) }
      end

      def to_json_hash
        { "applied" => @applied, "rejected" => @rejected.map(&:to_json_hash) }
      end

      def as_json(*)
        to_json_hash
      end
    end
  end
end
