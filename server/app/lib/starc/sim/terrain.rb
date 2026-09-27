# frozen_string_literal: true

module Starc
  module Sim
    # Authoritative height field — the Ruby half of shared/TERRAIN.md.
    #
    # This mirrors `client/src/render/terrain/heightfield.ts` line for line
    # (lattice hash, Hermite value noise, 5-octave fBm, 16 m radial border
    # falloff, metre-grid bilinear interpolation). Unit Z in every snapshot
    # comes from here, so the two implementations MUST agree to 1e-9 or units
    # visibly float on one side. Do not "improve" this algorithm.
    class Terrain
      OCTAVES = 5
      BASE_FREQ = 1.0 / 48.0
      LACUNARITY = 2.0
      GAIN = 0.5
      MAX_RELIEF = 6.0
      WATER_LEVEL = 0.0
      AIR_ALTITUDE = 6.0
      BORDER_FALLOFF = 16.0
      NORMAL_EPS = 1.0

      MASK = 0xFFFF_FFFF
      UINT32_RANGE = 4_294_967_296.0
      TWO_POW_32 = 4_294_967_296

      class << self
        # Height fields are immutable and expensive to build (O(size^2) fBm),
        # so they are cached per map id for the life of the process.
        def for(map_id)
          id = map_id.to_s
          cache = (@cache ||= {})
          cache[id] ||= new(Starc::Maps.find(id) || raise(ArgumentError, "unknown map #{id.inspect}"))
        end

        def for_map(map)
          id = map["id"] || map[:id]
          cache = (@cache ||= {})
          cache[id.to_s] ||= new(map)
        end

        def cached?(map_id)
          !!(@cache && @cache.key?(map_id.to_s))
        end

        def clear_cache!
          @cache = {}
        end
      end

      attr_reader :map, :size, :map_id

      def initialize(map)
        @map = map
        @map_id = (map["id"] || map[:id]).to_s
        @size = (map["size"] || 256).to_i
        @terrain_seed = (map["terrain_seed"] || 0).to_i
        @elevation = (map["elevation"] || 1.0).to_f
        @grid = build_grid
      end

      # Bilinearly interpolated height in metres, clamped to the map bounds.
      def height_at(x, z)
        n = @size + 1
        cx = clamp(x, 0.0, @size.to_f)
        cz = clamp(z, 0.0, @size.to_f)
        ix = cx.floor
        iz = cz.floor
        ix = @size - 1 if ix > @size - 1
        iz = @size - 1 if iz > @size - 1
        fx = cx - ix
        fz = cz - iz
        g = @grid
        h00 = g[iz * n + ix]
        h10 = g[iz * n + ix + 1]
        h01 = g[(iz + 1) * n + ix]
        h11 = g[(iz + 1) * n + ix + 1]
        lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz)
      end
      alias sample height_at

      def passable?(x, z)
        height_at(x, z) > WATER_LEVEL
      end

      def water_level
        WATER_LEVEL
      end

      def air_altitude
        AIR_ALTITUDE
      end

      # Surface normal from central differences — [x, y, z], normalised, y up.
      def normal_at(x, z, eps = NORMAL_EPS)
        hl = height_at(x - eps, z)
        hr = height_at(x + eps, z)
        hd = height_at(x, z - eps)
        hu = height_at(x, z + eps)
        nx = hl - hr
        nz = hd - hu
        ny = 2 * eps
        len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz))
        len = 1.0 if len.zero?
        [nx / len, ny / len, nz / len]
      end

      # 0 = flat, 1 = vertical.
      def slope(x, z, eps = NORMAL_EPS)
        1.0 - normal_at(x, z, eps)[1]
      end

      # Clamp a world coordinate into `0..size` on both axes at once.
      def clamp_to_world(x, z)
        [clamp(x, 0.0, @size.to_f), clamp(z, 0.0, @size.to_f)]
      end

      def in_bounds?(x, z)
        x >= 0.0 && x <= @size.to_f && z >= 0.0 && z <= @size.to_f
      end

      def start_position(slot)
        positions = @map["start_positions"] || []
        return { "x" => @size / 2.0, "y" => @size / 2.0 } if positions.empty?

        p = positions[slot.to_i % positions.size]
        { "x" => p["x"].to_f, "y" => p["y"].to_f }
      end

      def mineral_clusters
        @map["mineral_clusters"] || []
      end

      def expansion_candidates
        @map["expansion_candidates"] || []
      end

      def max_players
        (@map["max_players"] || 2).to_i
      end

      private

      def build_grid
        n = @size + 1
        grid = Array.new(n * n, 0.0)
        iz = 0
        while iz < n
          ix = 0
          while ix < n
            grid[iz * n + ix] = raw_height(ix, iz)
            ix += 1
          end
          iz += 1
        end
        grid
      end

      def raw_height(ix, iz)
        h = fbm(ix.to_f, iz.to_f)
        half = @size / 2.0
        dx = (ix.to_f - half).abs - (half - BORDER_FALLOFF)
        dx = 0.0 if dx.negative?
        dz = (iz.to_f - half).abs - (half - BORDER_FALLOFF)
        dz = 0.0 if dz.negative?
        edge = Math.sqrt((dx * dx) + (dz * dz)) / BORDER_FALLOFF
        edge = 1.0 if edge > 1.0
        h * @elevation * MAX_RELIEF * (1.0 - edge)
      end

      # Five-octave fBm of value noise, per shared/TERRAIN.md.
      def fbm(x, z)
        sum = 0.0
        amp = 1.0
        norm = 0.0
        f = BASE_FREQ
        OCTAVES.times do
          sum += amp * value_noise(x * f, z * f)
          norm += amp
          amp *= GAIN
          f *= LACUNARITY
        end
        sum / norm
      end

      def value_noise(x, z)
        ix = x.floor
        iz = z.floor
        fx = x - ix
        fz = z - iz
        ux = fx * fx * (3.0 - (2.0 * fx))
        uz = fz * fz * (3.0 - (2.0 * fz))
        a = lattice(ix, iz)
        b = lattice(ix + 1, iz)
        c = lattice(ix, iz + 1)
        d = lattice(ix + 1, iz + 1)
        lerp(lerp(a, b, ux), lerp(c, d, ux), uz)
      end

      # Accumulate on the signed 64-bit value, then reduce once mod 2^32, so
      # negative lattice coordinates wrap exactly like the TypeScript `% 2^32`.
      def lattice(ix, iz)
        h = (ix * 374_761_393) + (iz * 668_265_263) + (@terrain_seed * 2_654_435_761)
        h &= MASK
        h ^= h >> 13
        h = (h * 1_274_126_177) & MASK
        h ^= h >> 16
        h / UINT32_RANGE
      end

      def lerp(a, b, t)
        a + ((b - a) * t)
      end

      def clamp(v, lo, hi)
        return lo if v < lo
        return hi if v > hi

        v
      end
    end
  end
end
