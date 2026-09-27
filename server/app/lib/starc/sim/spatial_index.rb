# frozen_string_literal: true

module Starc
  module Sim
    # Uniform-grid broadphase for the simulation.
    #
    # Every target acquisition, splash application, aura tick and unit
    # separation step goes through here instead of scanning the entity table,
    # which is what keeps a 20 Hz tick flat as the entity count grows. The grid
    # is maintained incrementally — `insert`/`remove`/`update_position` are
    # O(1) and a query never rebuilds anything.
    class SpatialIndex
      CELL_SIZE = 8.0
      MAX_CELLS_PER_QUERY = 512

      def initialize(cell_size = CELL_SIZE)
        @cell_size = cell_size.to_f
        @inv_cell = 1.0 / @cell_size
        @cells = {}
        @loc = {} # entity id => [cell_x, cell_z, index_within_cell]
        @count = 0
      end

      attr_reader :count, :cell_size

      def each_key_of(entity)
        @loc[entity.id]
      end

      def insert(entity)
        return if @loc.key?(entity.id)

        cx, cz = cell_of(entity.x, entity.z)
        cell = @cells[key_for(cx, cz)]
        if cell.nil?
          @cells[key_for(cx, cz)] = [entity]
          @loc[entity.id] = [cx, cz, 0]
        else
          cell << entity
          @loc[entity.id] = [cx, cz, cell.size - 1]
        end
        @count += 1
        entity
      end

      def remove(id)
        entry = @loc.delete(id)
        return nil unless entry

        cx, cz, index = entry
        cell = @cells[key_for(cx, cz)]
        unless cell.nil?
          entity = cell[index]
          last = cell.pop
          # Swap-remove keeps removal O(1); repair the moved entity's index.
          if index < cell.size && last
            cell[index] = last
            moved = @loc[last.id]
            moved[2] = index if moved
          end
        end
        @count -= 1
        nil
      end

      def update_position(entity)
        entry = @loc[entity.id]
        return insert(entity) unless entry

        cx, cz = cell_of(entity.x, entity.z)
        return if cx == entry[0] && cz == entry[1]

        remove(entity.id)
        insert(entity)
      end

      def clear
        @cells.clear
        @loc.clear
        @count = 0
      end

      # All entities whose centre lies within `radius` of (x, z).
      def query_radius(x, z, radius, except_id = nil)
        return [] if @count.zero? || radius.negative?

        r2 = radius * radius
        out = []
        each_cell_covering(x - radius, z - radius, x + radius, z + radius) do |cell|
          i = 0
          n = cell.size
          while i < n
            e = cell[i]
            i += 1
            next if except_id && e.id == except_id

            dx = e.x - x
            dz = e.z - z
            out << e if (dx * dx) + (dz * dz) <= r2
          end
        end
        out
      end

      # All entities inside the axis-aligned rectangle (inclusive bounds).
      def query_rect(x0, z0, x1, z1, except_id = nil)
        return [] if @count.zero?

        min_x = x0 < x1 ? x0 : x1
        max_x = x0 < x1 ? x1 : x0
        min_z = z0 < z1 ? z0 : z1
        max_z = z0 < z1 ? z1 : z0
        out = []
        each_cell_covering(min_x, min_z, max_x, max_z) do |cell|
          cell.each do |e|
            next if except_id && e.id == except_id
            next if e.x < min_x || e.x > max_x || e.z < min_z || e.z > max_z

            out << e
          end
        end
        out
      end

      # Iterate the cells overlapping a box. Degenerate boxes (r <= 0) visit
      # exactly the one cell containing the point.
      def each_cell_covering(min_x, min_z, max_x, max_z)
        cx0, cz0 = cell_of(min_x, min_z)
        cx1, cz1 = cell_of(max_x, max_z)
        width = cx1 - cx0 + 1
        height = cz1 - cz0 + 1
        return if (width * height) > MAX_CELLS_PER_QUERY

        cz = cz0
        while cz <= cz1
          cx = cx0
          while cx <= cx1
            cell = @cells[key_for(cx, cz)]
            yield cell if cell
            cx += 1
          end
          cz += 1
        end
      end

      private

      def cell_of(x, z)
        [(x * @inv_cell).floor, (z * @inv_cell).floor]
      end

      # Cell coordinates are clamped non-negative, so a single Integer key is
      # collision-free and cheaper than a two-element Array key.
      def key_for(cx, cz)
        (cz << 12) | cx
      end
    end
  end
end
