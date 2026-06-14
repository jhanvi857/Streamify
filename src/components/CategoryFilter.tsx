"use client";

const CATEGORIES = [
  "all",
  "dev talks",
  "tutorials",
  "demos",
  "design",
  "system design",
  "recently watched",
];

interface CategoryFilterProps {
  activeCategory: string;
  onSelectCategory: (category: string) => void;
}

export default function CategoryFilter({
  activeCategory,
  onSelectCategory,
}: CategoryFilterProps) {
  return (
    <div className="w-full overflow-x-auto py-4 scrollbar-none flex items-center gap-3">
      {CATEGORIES.map((category) => {
        const isActive = activeCategory === category;
        return (
          <button
            key={category}
            onClick={() => onSelectCategory(category)}
            className={`whitespace-nowrap px-4 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 select-none cursor-pointer ${
              isActive
                ? "bg-brand-red border-brand-red text-white shadow-lg shadow-brand-red/20"
                : "bg-dark-card border-dark-border text-gray-400 hover:text-white hover:border-gray-600"
            }`}
          >
            {category}
          </button>
        );
      })}
    </div>
  );
}
