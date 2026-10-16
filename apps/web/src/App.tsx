import { CreateRoom } from './pages/CreateRoom.tsx';
import { Home } from './pages/Home.tsx';
import { Join } from './pages/Join.tsx';
import { Room } from './pages/Room.tsx';
import { useRoute } from './lib/router.ts';

export function App() {
  const route = useRoute();
  switch (route.name) {
    case 'new':
      return <CreateRoom />;
    case 'join':
      return <Join code={route.code} roomId={route.roomId} />;
    case 'room':
      return <Room key={route.roomId} roomId={route.roomId} hostToken={route.hostToken} />;
    default:
      return <Home />;
  }
}
