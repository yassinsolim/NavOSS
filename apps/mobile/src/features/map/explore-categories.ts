import type { ComponentProps } from 'react';
import type { SearchQuery } from '@navoss/contracts';

import type { SymbolView } from 'expo-symbols';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

export interface ExploreCategory {
  icon: SymbolName;
  id: string;
  label: string;
  query: string;
  searchCategory?: SearchQuery['category'];
}

export interface ExploreCategoryGroup {
  categories: ExploreCategory[];
  icon: SymbolName;
  id: string;
  label: string;
}

export const EXPLORE_CATEGORY_GROUPS: ExploreCategoryGroup[] = [
  {
    categories: [
      {
        icon: { android: 'restaurant', ios: 'fork.knife' },
        id: 'restaurants',
        label: 'Restaurants',
        query: 'restaurant',
        searchCategory: 'restaurant',
      },
      {
        icon: { android: 'local_bar', ios: 'wineglass' },
        id: 'bars',
        label: 'Bars',
        query: 'bar',
      },
      {
        icon: { android: 'local_cafe', ios: 'cup.and.saucer.fill' },
        id: 'coffee',
        label: 'Coffee',
        query: 'cafe',
      },
      {
        icon: { android: 'brunch_dining', ios: 'takeoutbag.and.cup.and.straw.fill' },
        id: 'brunch',
        label: 'Brunch',
        query: 'brunch restaurant',
      },
      {
        icon: { android: 'cake', ios: 'birthday.cake.fill' },
        id: 'dessert',
        label: 'Dessert',
        query: 'dessert',
      },
      {
        icon: { android: 'takeout_dining', ios: 'takeoutbag.and.cup.and.straw.fill' },
        id: 'takeout',
        label: 'Takeout',
        query: 'takeaway',
      },
      {
        icon: { android: 'delivery_dining', ios: 'bicycle' },
        id: 'delivery',
        label: 'Delivery',
        query: 'food delivery',
      },
    ],
    icon: { android: 'restaurant', ios: 'fork.knife' },
    id: 'food-drink',
    label: 'Food & Drink',
  },
  {
    categories: [
      {
        icon: { android: 'attractions', ios: 'ticket.fill' },
        id: 'attractions',
        label: 'Attractions',
        query: 'attraction',
      },
      {
        icon: { android: 'park', ios: 'tree.fill' },
        id: 'parks',
        label: 'Parks',
        query: 'park',
        searchCategory: 'park',
      },
      {
        icon: { android: 'fitness_center', ios: 'dumbbell.fill' },
        id: 'gyms',
        label: 'Gyms',
        query: 'gym',
      },
      {
        icon: { android: 'palette', ios: 'paintpalette.fill' },
        id: 'art',
        label: 'Art',
        query: 'art gallery',
      },
      {
        icon: { android: 'nightlife', ios: 'moon.stars.fill' },
        id: 'nightlife',
        label: 'Nightlife',
        query: 'nightclub',
      },
      {
        icon: { android: 'music_note', ios: 'music.note' },
        id: 'live-music',
        label: 'Live music',
        query: 'live music',
      },
      {
        icon: { android: 'movie', ios: 'film.fill' },
        id: 'movies',
        label: 'Movies',
        query: 'cinema',
      },
      {
        icon: { android: 'museum', ios: 'building.columns.fill' },
        id: 'museums',
        label: 'Museums',
        query: 'museum',
      },
      {
        icon: { android: 'local_library', ios: 'books.vertical.fill' },
        id: 'libraries',
        label: 'Libraries',
        query: 'library',
      },
    ],
    icon: { android: 'attractions', ios: 'ticket.fill' },
    id: 'things-to-do',
    label: 'Things to do',
  },
  {
    categories: [
      {
        icon: { android: 'shopping_cart', ios: 'cart.fill' },
        id: 'groceries',
        label: 'Groceries',
        query: 'supermarket',
        searchCategory: 'grocery',
      },
      {
        icon: { android: 'spa', ios: 'sparkles' },
        id: 'beauty-supplies',
        label: 'Beauty supplies',
        query: 'beauty supply store',
      },
      {
        icon: { android: 'directions_car', ios: 'car.fill' },
        id: 'car-dealers',
        label: 'Car dealers',
        query: 'car dealership',
      },
      {
        icon: { android: 'chair', ios: 'house.fill' },
        id: 'home-garden',
        label: 'Home & garden',
        query: 'home improvement store',
      },
      {
        icon: { android: 'checkroom', ios: 'tshirt.fill' },
        id: 'apparel',
        label: 'Apparel',
        query: 'clothing store',
      },
      {
        icon: { android: 'local_mall', ios: 'bag.fill' },
        id: 'shopping-centres',
        label: 'Shopping centres',
        query: 'shopping centre',
      },
      {
        icon: { android: 'devices', ios: 'laptopcomputer' },
        id: 'electronics',
        label: 'Electronics',
        query: 'electronics store',
      },
      {
        icon: { android: 'sports_basketball', ios: 'basketball.fill' },
        id: 'sporting-goods',
        label: 'Sporting goods',
        query: 'sporting goods store',
      },
      {
        icon: { android: 'storefront', ios: 'storefront.fill' },
        id: 'convenience-stores',
        label: 'Convenience stores',
        query: 'convenience store',
      },
    ],
    icon: { android: 'local_mall', ios: 'bag.fill' },
    id: 'shopping',
    label: 'Shopping',
  },
  {
    categories: [
      {
        icon: { android: 'hotel', ios: 'bed.double.fill' },
        id: 'hotels',
        label: 'Hotels',
        query: 'hotel',
      },
      {
        icon: { android: 'local_atm', ios: 'banknote.fill' },
        id: 'atms',
        label: 'ATMs',
        query: 'atm',
      },
      {
        icon: { android: 'content_cut', ios: 'scissors' },
        id: 'beauty-salons',
        label: 'Beauty salons',
        query: 'beauty salon',
      },
      {
        icon: { android: 'car_repair', ios: 'wrench.and.screwdriver.fill' },
        id: 'car-repair',
        label: 'Car repair',
        query: 'car repair',
      },
      {
        icon: { android: 'local_car_wash', ios: 'drop.fill' },
        id: 'car-wash',
        label: 'Car wash',
        query: 'car wash',
      },
      {
        icon: { android: 'dry_cleaning', ios: 'washer.fill' },
        id: 'dry-cleaning',
        label: 'Dry cleaning',
        query: 'dry cleaner',
      },
      {
        icon: { android: 'ev_station', ios: 'bolt.car.fill' },
        id: 'charging-stations',
        label: 'Charging stations',
        query: 'charging station',
      },
      {
        icon: { android: 'local_gas_station', ios: 'fuelpump.fill' },
        id: 'gas',
        label: 'Gas',
        query: 'fuel',
      },
      {
        icon: { android: 'local_hospital', ios: 'cross.case.fill' },
        id: 'hospitals-clinics',
        label: 'Hospitals and clinics',
        query: 'hospital clinic',
      },
      {
        icon: { android: 'local_shipping', ios: 'shippingbox.fill' },
        id: 'mail-shipping',
        label: 'Mail and shipping',
        query: 'post office shipping',
      },
      {
        icon: { android: 'local_parking', ios: 'parkingsign.circle.fill' },
        id: 'parking',
        label: 'Parking',
        query: 'parking',
      },
      {
        icon: { android: 'local_pharmacy', ios: 'pills.fill' },
        id: 'pharmacies',
        label: 'Pharmacies',
        query: 'pharmacy',
      },
    ],
    icon: { android: 'miscellaneous_services', ios: 'wrench.and.screwdriver.fill' },
    id: 'services',
    label: 'Services',
  },
];

const categoryById = new Map(
  EXPLORE_CATEGORY_GROUPS.flatMap((group) => group.categories).map((category) => [
    category.id,
    category,
  ]),
);

export const QUICK_EXPLORE_CATEGORY_IDS = [
  'restaurants',
  'coffee',
  'gas',
  'groceries',
  'shopping-centres',
  'beauty-salons',
  'parks',
] as const;

export const QUICK_EXPLORE_CATEGORIES = QUICK_EXPLORE_CATEGORY_IDS.map((id) => {
  const category = categoryById.get(id);
  if (category === undefined) {
    throw new Error(`Unknown quick explore category: ${id}`);
  }
  if (id === 'coffee') return { ...category, label: 'Cafe' };
  if (id === 'shopping-centres') return { ...category, label: 'Shopping' };
  return category;
});

export function exploreCategoryById(id: string): ExploreCategory | undefined {
  return categoryById.get(id);
}
