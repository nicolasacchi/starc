# frozen_string_literal: true

module Starc
  module Sim
    # mulberry32 — the PRNG specified by PROTOCOL.md §6.
    #
    #   PRNG: mulberry32, seeded `seed ^ imul(player_id, 0x9E3779B1)`.
    #
    # Pure: the whole state is the 32-bit unsigned integer below, so two
    # Rng objects built from the same seed produce byte-identical streams with
    # no global state involved. All arithmetic is masked to 32 bits, which is
    # what the JavaScript reference (`Math.imul`, `>>> 0`) does.
    class Rng
      MASK = 0xFFFF_FFFF
      UINT32_RANGE = 4_294_967_296.0
      PHI32 = 0x9E37_79B1
      GAMMA = 0x6D2B_79F5

      # `imul(player_id, 0x9E3779B1)` from the protocol.
      def self.stream_seed(seed, player_id)
        ((seed.to_i ^ ((player_id.to_i * PHI32) & MASK)) & MASK)
      end

      attr_reader :seed_value

      def initialize(seed)
        @seed_value = seed.to_i & MASK
        @state = @seed_value
      end

      # Uniform float in [0.0, 1.0).
      def next_float
        @state = (@state + GAMMA) & MASK
        t = @state
        t = ((t ^ (t >> 15)) * (t | 1)) & MASK
        t = (t ^ (t + ((((t ^ (t >> 7)) * (t | 61)) & MASK)))) & MASK
        t = (t ^ (t >> 14)) & MASK
        t / UINT32_RANGE
      end

      # Uniform integer in 0...max. `max <= 0` yields 0.
      def int(max)
        return 0 if max <= 0

        v = (next_float * max).floor
        v.negative? ? 0 : (v >= max ? max - 1 : v)
      end

      def pick(array)
        return nil if array.nil? || array.empty?

        array[int(array.size)]
      end

      # Range sampling, shared by the opening placement.
      def range(lo, hi)
        lo + (hi - lo) * next_float
      end

    end
  end
end
