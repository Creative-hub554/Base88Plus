// app.js
let tasks = JSON.parse(localStorage.getItem('tasks')) || [];

function renderTasks() {
  const taskList = document.getElementById('taskList');
  const taskCount = document.getElementById('taskCount');
  const taskInput = document.getElementById('taskInput');
  taskList.innerHTML = '';
  tasks.forEach((task, index) => {
    const li = document.createElement('li');
    li.className = `task ${task.done ? 'done' : ''}`;
    li.innerHTML = `
      <input type="checkbox" ${task.done ? 'checked' : ''} onclick="toggleTask(${index})">
      <span>${task.text}</span>
      <button onclick="removeTask(${index})">Remove</button>
    `;
    taskList.appendChild(li);
  });
  taskCount.textContent = tasks.filter(task => !task.done).length;
}

function addTask() {
  const taskInput = document.getElementById('taskInput');
  const newTask = {
    text: taskInput.value,
    done: false
  };
  tasks.push(newTask);
  taskInput.value = '';
  localStorage.setItem('tasks', JSON.stringify(tasks));
  renderTasks();
}

function toggleTask(index) {
  tasks[index].done = !tasks[index].done;
  localStorage.setItem('tasks', JSON.stringify(tasks));
  renderTasks();
}

function removeTask(index) {
  tasks.splice(index, 1);
  localStorage.setItem('tasks', JSON.stringify(tasks));
  renderTasks();
}

document.querySelector('.add-task').addEventListener('submit', (e) => {
  e.preventDefault();
  addTask();
});

renderTasks();